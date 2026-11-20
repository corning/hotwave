/**
 * Gateway RPC 方法实现
 *
 * Handler 签名:
 *   (params, client, ctx) → { ok, payload?, error? }
 */

import { timingSafeEqual } from "node:crypto";
import type { AgentLike } from "../contracts.js";
import type { MiniAgentEvent } from "../events.js";
import { linkifyStockMentions } from "../../common/stock-linkify.js";
import { fetchServerOneGet } from "../../tools/server-app-data.js";
import {
  ErrorCodes, errorShape,
  PROTOCOL_VERSION, GATEWAY_METHODS, GATEWAY_EVENTS,
  TICK_INTERVAL_MS, MAX_PAYLOAD_BYTES, newId,
  type HelloOk, type ErrorShape,
  type MonitorItem, type MonitorAlert, type MonitorStatus,
} from "./protocol.js";
import { MonitorManager, type AlertCallback } from "./monitor-manager.js";
import type { NotificationRouter, ChannelNotificationConfig } from "./notification-router.js";
import { EastMoneyTrader } from "../../trader/eastmoney.js";
import { TradeRouter } from "../../trader/router.js";

import { approvalBridge } from "./control-bridge.js";
import type { ApprovalDecision } from "../../common/tool-approval.js";

// session_change 冷却（bug-263）：同一转换点 N min 内不重复触发 heartbeat，
// 防 monitor_engine 边界抖动 + hotwave 端双保险。monitor_engine engine.py:586 已有 _last_session
// 去重，此为第二道防线。5 个 KEY_TRANSITIONS 每个独立计时。
const SESSION_CHANGE_COOLDOWN_MS = 5 * 60 * 1000; // 5min
const lastSessionChangeAt = new Map<string, number>();

// 活跃 run 注册表（P2 控制面）：sessionKey -> 当前 runId，供 chat.abort / agent.state 使用。
// 同一 sessionKey 只保留最近一次 run（agent 内部有 lane 串行，不会真正并发）。
const activeRuns = new Map<string, { runId: string; startedAt: number }>();

// ============== 类型 ==============

export type GwClient = {
  id: string;
  socket: { send: (data: string) => void; close: (code?: number, reason?: string) => void; bufferedAmount: number };
  authed: boolean;
};

export type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

export type HandlerContext = {
  agent: AgentLike;
  broadcast: BroadcastFn;
  clients: Set<GwClient>;
  token?: string;
  nonces: Map<string, string>;
  startedAt: number;
  monitorManager: MonitorManager;
  notificationRouter?: NotificationRouter;
};

export type HandlerResult = { ok: boolean; payload?: unknown; error?: ErrorShape };
export type Handler = (params: unknown, client: GwClient, ctx: HandlerContext) => Promise<HandlerResult>;

// ============== 安全工具（timing-safe 比较） ==============

/** 防计时攻击的字符串比较 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ============== connect ==============

const handleConnect: Handler = async (params, client, ctx) => {
  const p = params as { token?: string; nonce?: string } | undefined;

  // token 验证（timingSafeEqual 防计时攻击）
  if (ctx.token) {
    if (!p?.token || !safeEqual(p.token, ctx.token)) {
      return { ok: false, error: errorShape(ErrorCodes.UNAUTHORIZED, "invalid token") };
    }
  }

  // nonce 验证（challenge-response）
  const expectedNonce = ctx.nonces.get(client.id);
  if (expectedNonce && p?.nonce !== expectedNonce) {
    return { ok: false, error: errorShape(ErrorCodes.UNAUTHORIZED, "nonce mismatch") };
  }
  ctx.nonces.delete(client.id);

  client.authed = true;

  const hello: HelloOk = {
    protocol: PROTOCOL_VERSION,
    methods: [...GATEWAY_METHODS],
    events: [...GATEWAY_EVENTS],
    policy: { tickIntervalMs: TICK_INTERVAL_MS, maxPayloadBytes: MAX_PAYLOAD_BYTES },
  };
  return { ok: true, payload: hello };
};

// ============== chat.send ==============

/**
 * 1. 立即返回 { sessionKey, runId } (ACK)
 * 2. 异步执行 agent.run()
 * 3. agent 事件流 → broadcast("agent") + broadcast("chat" delta/final)
 */
const handleChatSend: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string; message?: string } | undefined;
  if (!p?.message) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "message required") };
  }
  const sessionKey = p.sessionKey || "main";
  const runId = newId();

  // 登记活跃 run：供 chat.abort 中断、agent.state 查询
  activeRuns.set(sessionKey, { runId, startedAt: Date.now() });

  // 追踪 agent 内部的 runId（通过 agent_start 事件获取）
  let agentRunId: string | undefined = runId;
  // 累积所有 message_delta 文本，在 final 中一并发送（供 channel 等非 SSE 客户端获取完整文本）
  let accumulatedText = "";

  // 异步执行，不阻塞响应（ACK-then-stream 模式）
  const unsub = ctx.agent.subscribe((event: MiniAgentEvent) => {
    // 捕获 agent 内部 runId，用于后续事件关联。
    // agent 内部 sessionKey 格式为 "agent:{agentId}:{sessionKey}"（如 "agent:main:main"），
    // handleChatSend 的 sessionKey 是裸 "main"。用 endsWith 匹配避免格式差异漏广播。
    if (event.type === "agent_start" && (event.sessionKey === sessionKey || (typeof event.sessionKey === 'string' && event.sessionKey.endsWith(':' + sessionKey)))) {
      agentRunId = event.runId;
      // 立即广播"思考中"状态：让客户端在 LLM 首个事件到达前就显示状态栏，
      // 避免长思考模型（如 glm-5.2 extended thinking）期间 SSE 无任何事件 -> "长期无反应"。
      // tool="" 表示纯思考（非工具执行），客户端据此只设状态、不污染 toolHistory。
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "thinking", tool: "" });
      console.log(`[Gateway/handler] agent_start 广播 thinking (agentRunId=${agentRunId})`);
    }

    // 仅转发属于本次 run 的事件（按 sessionKey 过滤，避免并发混杂）
    const eventRunId = "runId" in event ? (event as { runId: string }).runId : undefined;
    if (eventRunId && eventRunId !== agentRunId) return;

    // 桥接 agent 事件 → gateway 广播
    ctx.broadcast("agent", { ...event, sessionKey });
    console.log(`[Gateway/handler] event type=${event.type} sessionKey=${sessionKey}`);

    // 转换为 chat delta/final
    // 不设限流，逐 token 实时广播以实现打字机效果
    //
    // 重要: message_end 只是内层单轮 LLM 响应的文本结束（工具执行前），
    // 不广播为 final — 否则 bridge 会提前关闭 SSE 流，
    // 导致工具执行后的第二轮 delta 全部丢失。
    // agent_end 才是真正的运行结束。
    if (event.type === "message_delta") {
      accumulatedText += event.delta;
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "delta", text: event.delta }, { dropIfSlow: true });
    } else if (event.type === "thinking_delta") {
      // 桥接 extended thinking 推理内容 → 客户端实时展示思考过程
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "reasoning", text: event.delta }, { dropIfSlow: true });
    } else if (event.type === "agent_end") {
      console.log(`[Gateway/handler] agent_end: turns=${event.turns} toolCalls=${event.toolCalls}`);
      // 兜底清除思考状态：agent 未调工具时无 tool_execution_end 清除 isThinking，
      // 此处补 thinking_done 防止客户端状态栏卡在"思考中..."。
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "thinking_done", tool: "" });
      // final 用 linkify 后的完整文本：把裸股票/指数代码标注为可点击链接，
      // 供客户端 MarkdownBody onTapLink 跳转详情页。delta 已原样流式发出，
      // 这里在最终文本统一补链接，避免流式过程中重复替换导致抖动。
      const finalText = accumulatedText ? linkifyStockMentions(accumulatedText) : accumulatedText;
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "final", text: finalText || undefined });
    } else if (event.type === "agent_error") {
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "error", error: event.error });
    } else if (event.type === "tool_execution_start") {
      // 工具执行开始 → 通知客户端保持连接活跃，显示"Agent 正在思考"
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "thinking", tool: event.toolName });
    } else if (event.type === "tool_execution_end") {
      // 工具执行结束
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "thinking_done", tool: event.toolName, isError: event.isError });
    }
  });

  ctx.agent.run(sessionKey, p.message, { runId })
    .catch((err) => {
      // 广播运行时错误，确保客户端能收到错误通知
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "error", error: String(err) });
    })
    .finally(() => {
      unsub();
      const cur = activeRuns.get(sessionKey);
      if (cur?.runId === runId) activeRuns.delete(sessionKey);
    });

  return { ok: true, payload: { sessionKey, runId } };
};

// ============== chat.history ==============

const handleChatHistory: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string; limit?: number } | undefined;
  const sessionKey = p?.sessionKey || "main";
  const all = ctx.agent.getHistory(sessionKey);
  // limit 模式：裁剪条数 + 单条截断，避免大 WS 帧冻结 WebView（桌面端）
  if (p?.limit && p.limit > 0) {
    const MAX_CHARS = 8000;
    const messages = all.slice(-p.limit).map((m: any) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content.length > MAX_CHARS
            ? m.content.slice(0, MAX_CHARS)
            : m.content
          : "",
      timestamp: m.timestamp,
    }));
    return { ok: true, payload: { sessionKey, messages } };
  }
  return { ok: true, payload: { sessionKey, messages: all } };
};

// ============== sessions.list ==============

const handleSessionsList: Handler = async (_params, _client, ctx) => {
  const sessions = await ctx.agent.listSessions();
  return { ok: true, payload: { sessions } };
};

// ============== sessions.reset ==============

const handleSessionsReset: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string } | undefined;
  const sessionKey = p?.sessionKey || "main";
  await ctx.agent.reset(sessionKey);
  return { ok: true, payload: { sessionKey } };
};

// ============== health ==============

const handleHealth: Handler = async (_params, _client, ctx) => {
  return {
    ok: true,
    payload: {
      uptimeMs: Date.now() - ctx.startedAt,
      clients: ctx.clients.size,
      authedClients: [...ctx.clients].filter((c) => c.authed).length,
    },
  };
};

// ============== monitor.subscribe ==============

const handleMonitorSubscribe: Handler = async (params, _client, ctx) => {
  const p = params as { items?: MonitorItem[] } | undefined;
  if (!p?.items || !Array.isArray(p.items) || p.items.length === 0) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "items array required") };
  }

  // 验证每个 item
  for (const item of p.items) {
    if (!item.id || !item.symbol || !item.type) {
      return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, `invalid item: missing id/symbol/type`) };
    }
    if (item.interval < 1 || item.interval > 300) {
      return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, `interval must be 1-300s`) };
    }
  }

  // 为每个 item 填补股票名称
  for (const item of p.items) {
    if (!item.name) {
      item.name = await resolveStockName(item.symbol);
    }
  }

  const result = ctx.monitorManager.subscribe(p.items);
  ctx.broadcast("monitor.status_change", ctx.monitorManager.getStatusWithItems());

  // 为新增的非指数标的生成 info 告警
  for (const item of p.items) {
    if (item.type === "index") continue;
    ctx.monitorManager.raiseAlert({
      level: "info",
      item: { id: item.id, symbol: item.symbol, type: item.type },
      metrics: {},
      message: `${item.name ?? item.symbol} 已添加监控`,
    });
  }

  return { ok: true, payload: result };
};

// ============== monitor.unsubscribe ==============

const handleMonitorUnsubscribe: Handler = async (params, _client, ctx) => {
  const p = params as { itemIds?: string[] } | undefined;

  // 告警生成（必须在 unsubscribe 之前，unsubscribe 会清理 lastAlertTime）
  if (p?.itemIds) {
    const currentItems = ctx.monitorManager.getItems();
    for (const id of p.itemIds) {
      const item = currentItems.find(i => i.id === id);
      if (!item || item.type === "index") continue;
      ctx.monitorManager.raiseAlert({
        level: "info",
        item: { id: item.id, symbol: item.symbol, type: item.type },
        metrics: {},
        message: `${item.name ?? item.symbol} 已取消监控`,
      });
    }
  }

  // 阻止删除 index 类型标的
  if (p?.itemIds) {
    const items = ctx.monitorManager.getItems();
    const indexIds = new Set(items.filter(i => i.type === "index").map(i => i.id));
    p.itemIds = p.itemIds.filter(id => !indexIds.has(id));
  }

  const result = ctx.monitorManager.unsubscribe(p?.itemIds);
  ctx.broadcast("monitor.status_change", ctx.monitorManager.getStatusWithItems());
  return { ok: true, payload: result };
};

// ============== monitor.status ==============

const handleMonitorStatus: Handler = async (_params, _client, ctx) => {
  const status = ctx.monitorManager.getStatus();
  const recentAlerts = ctx.monitorManager.getAlertHistory(20);
  const items = ctx.monitorManager.getItems();
  // 为已存在但缺 name 的 item 填补名称
  for (const item of items) {
    if (!item.name) {
      item.name = await resolveStockName(item.symbol);
    }
  }
  return { ok: true, payload: { ...status, recentAlerts, items } };
};

// ============== monitor.instruct ==============

/**
 * 接收 LLM/用户对监控引擎的指令
 * 例如: "add sh600519 with 3% threshold", "link 茅台↔白酒板块"
 */
const handleMonitorInstruct: Handler = async (params, _client, ctx) => {
  const p = params as { instruction?: string; context?: Record<string, unknown> } | undefined;
  if (!p?.instruction) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "instruction required") };
  }

  console.log(`[Monitor] instruct: ${p.instruction}`, p.context ?? "");

  // monitor_engine_online / status_update: Monitor Engine 上报自身运行状态。
  // 必须据此 setRunning(true)，否则 monitor.status.running 永远为 false
  // （即便 engine 进程已连上 Gateway 并在采集数据）。
  if (p.instruction === "monitor_engine_online" || p.instruction === "status_update") {
    const c = (p.context ?? {}) as Record<string, unknown>;
    const running = p.instruction === "monitor_engine_online" ? true : Boolean(c.running);
    if (running) {
      ctx.monitorManager.setRunning(true);
    } else {
      ctx.monitorManager.setRunning(false);
    }
    if (typeof c.trading_session === "string" && c.trading_session) {
      ctx.monitorManager.setTradingSession(c.trading_session);
    }
    ctx.broadcast("monitor.status_change", ctx.monitorManager.getStatusWithItems());
    return { ok: true, payload: { instruction: p.instruction, running } };
  }

  // 简单指令解析：添加监控标的
  // 格式: "add SYMBOL with THRESHOLD% threshold"
  const addMatch = p.instruction.match(/add\s+(sh\d{6}|sz\d{6}|hk\d{5}|us[A-Z]+)(?:\s+with\s+(\d+(?:\.\d+)?)%?\s*(?:(price|volume|amplitude)\s*)?threshold)?/i);
  if (addMatch) {
    const symbol = addMatch[1].toLowerCase();
    const thresholdVal = addMatch[2] ? parseFloat(addMatch[2]) : 5;
    const metricType = (addMatch[3] || "price").toLowerCase();

    const name = await resolveStockName(symbol);
    const newItem: MonitorItem = {
      id: `manual-${symbol}`,
      symbol,
      type: "stock",
      name,
      interval: 3,
      thresholds: [{
        metric: metricType === "volume" ? "volume_ratio" : "price_change_pct",
        operator: "gte",
        value: metricType === "volume" ? thresholdVal / 100 : thresholdVal,
        level: "warning",
        message: `[监控] ${symbol} 触发 ${metricType} 阈值 ${thresholdVal}%`,
      }],
    };

    ctx.monitorManager.subscribe([newItem]);
    ctx.broadcast("monitor.status_change", ctx.monitorManager.getStatusWithItems());

    // 为非指数标的生成 info 告警
    if (newItem.type !== "index") {
      ctx.monitorManager.raiseAlert({
        level: "info",
        item: { id: newItem.id, symbol: newItem.symbol, type: newItem.type },
        metrics: {},
        message: `${newItem.name ?? newItem.symbol} 已添加监控`,
      });
    }

    return { ok: true, payload: { added: [symbol], instruction: "add" } };
  }

  // 格式: "remove SYMBOL" or "unsubscribe SYMBOL"
  const removeMatch = p.instruction.match(/(?:remove|unsubscribe|delete)\s+(sh\d{6}|sz\d{6}|hk\d{5}|us[A-Z]+)/i);
  if (removeMatch) {
    const symbol = removeMatch[1].toLowerCase();
    const items = ctx.monitorManager.getItems();
    const toRemove = items
      .filter(i => i.symbol === symbol && i.type !== "index")
      .map(i => i.id);

    // 为每个移除的标的生成告警
    for (const id of toRemove) {
      const item = items.find(i => i.id === id);
      if (!item) continue;
      ctx.monitorManager.raiseAlert({
        level: "info",
        item: { id: item.id, symbol: item.symbol, type: item.type },
        metrics: {},
        message: `${item.name ?? item.symbol} 已取消监控`,
      });
    }

    ctx.monitorManager.unsubscribe(toRemove);
    ctx.broadcast("monitor.status_change", ctx.monitorManager.getStatusWithItems());
    return { ok: true, payload: { removed: toRemove, instruction: "remove" } };
  }

  // alert: Monitor Engine 检测到的异动告警
  if (p.instruction === "alert" && p.context) {
    const alertData = p.context as Record<string, unknown>;
    // Engine 发来的 item 可能是对象 {id, symbol, type} 或纯 symbol 字符串
    const itemObj = typeof alertData.item === "object" && alertData.item !== null
      ? alertData.item as Record<string, unknown>
      : null;
    const alert = {
      level: (String(alertData.level ?? "info")) as "info" | "warning" | "critical",
      item: {
        id: String(itemObj?.id ?? `item-${alertData.symbol ?? "unknown"}`),
        symbol: String(itemObj?.symbol ?? alertData.symbol ?? "unknown"),
        type: String(itemObj?.type ?? alertData.type ?? "stock"),
      },
      metrics: (alertData.metrics ?? {}) as Record<string, number>,
      message: alertData.message ? String(alertData.message) : undefined,
      linked: alertData.linked as Array<{ symbol: string; change_pct: number }> | undefined,
    };

    // 通过 MonitorManager.raiseAlert 触发告警管道（冷却去重 + onAlert 回调 + broadcast）
    // 实时告警仅推送到监控页 SSE，不再路由到 IM（仅 heartbeat 定时简报推送 IM/聊天）
    const raised = ctx.monitorManager.raiseAlert(alert);
    if (raised) {
      console.log(`[Monitor] alert raised: ${raised.item.symbol} level=${raised.level}`);
    } else {
      console.log(`[Monitor] alert cooldown: ${alert.item.symbol}`);
    }

    return { ok: true, payload: { instruction: "alert", raised: !!raised } };
  }

  // session_change: Monitor Engine 广播的交易时段转换事件
  if (p.instruction === "session_change" && p.context) {
    const ctx_data = p.context as Record<string, unknown>;
    const from = String(ctx_data.from ?? "");
    const to = String(ctx_data.to ?? "");

    console.log(`[Monitor] session_change: ${from} → ${to}`);

    // 更新 MonitorManager 的交易时段状态
    ctx.monitorManager.setTradingSession(to);

    // 通过 NotificationRouter 路由时段转换通知到 IM 渠道
    if (ctx.notificationRouter) {
      ctx.notificationRouter.routeSessionChange(from, to);
    }

    // 关键 session 转换点触发 heartbeat（驱动 LLM 分析）
    const KEY_TRANSITIONS = [
      "idle→pre_open",     // 盘前开始
      "pre_open→morning",  // 正式开盘
      "morning→idle",      // 上午收盘 / 午休
      "idle→afternoon",    // 下午开盘
      "afternoon→idle",    // 收盘（15:00 后）
    ];
    const transitionKey = `${from}→${to}`;
    if (KEY_TRANSITIONS.includes(transitionKey)) {
      const lastTs = lastSessionChangeAt.get(transitionKey) ?? 0;
      if (Date.now() - lastTs < SESSION_CHANGE_COOLDOWN_MS) {
        console.log(
          `[Monitor] session_change ${transitionKey} 冷却中（${Date.now() - lastTs}ms < ${SESSION_CHANGE_COOLDOWN_MS}ms），跳过 heartbeat 触发（bug-263）`,
        );
      } else {
        lastSessionChangeAt.set(transitionKey, Date.now());
        ctx.agent.getHeartbeat().requestNow("session_change");
        console.log(`[Monitor] heartbeat triggered by session: ${transitionKey}`);
      }
    }

    // 广播时段变更到 WebSocket 客户端（供 Flutter 等前端使用）
    ctx.broadcast("monitor.status_change", ctx.monitorManager.getStatusWithItems());

    return { ok: true, payload: { instruction: "session_change", from, to } };
  }

  // 未知指令
  return { ok: true, payload: { instruction: "acknowledged", note: "instruction forwarded to monitor engine" } };
};

// ============== monitor.search_stocks ==============

type StockEntry = {
  symbol: string;
  name: string;
  ts_code: string;
  type: number;
};

let cachedStocks: StockEntry[] | null = null;
let cacheTime = 0;
const STOCKS_CACHE_TTL = 60_000; // 1 minute

/** 从全市场列表（server_app 提供，数据更新由 server_app 保证）中查找股票中文名称 */
async function resolveStockName(symbol: string): Promise<string | undefined> {
  try {
    const stocks = await loadStocks();
    return stocks.find(s => s.symbol === symbol)?.name;
  } catch {
    return undefined;
  }
}

/** 加载全市场列表（server_app /api/hotwave/stocks，权威源） */
async function loadStocks(): Promise<StockEntry[]> {
  const now = Date.now();
  if (cachedStocks && now - cacheTime < STOCKS_CACHE_TTL) return cachedStocks;

  const { ok, data } = await fetchServerOneGet("stocks");
  if (ok && Array.isArray(data) && data.length > 0) {
    cachedStocks = data as StockEntry[];
    cacheTime = now;
    return cachedStocks;
  }
  return [];
}

const handleMonitorSearchStocks: Handler = async (params) => {
  const q = (params as { q?: string })?.q?.trim().toLowerCase() || "";
  if (!q) return { ok: true, payload: [] };

  try {
    // server_app 侧过滤（避免全量列表每次传输到 hotwave）
    const { ok, data } = await fetchServerOneGet("stocks/search", { q });
    if (ok && Array.isArray(data)) return { ok: true, payload: data };
    return { ok: true, payload: [] };
  } catch (err) {
    console.error("[Gateway/monitor.search_stocks] error:", err);
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, String(err)) };
  }
};

// ============== notifications.register ==============

/**
 * 渠道注册通知配置
 * 渠道启动时调用此方法声明自己需要接收哪些类型的系统通知
 */
const handleNotificationsRegister: Handler = async (params, _client, ctx) => {
  if (!ctx.notificationRouter) {
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, "notification router not available") };
  }
  const p = params as { config?: ChannelNotificationConfig } | undefined;
  if (!p?.config) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "config required") };
  }
  ctx.notificationRouter.register(p.config);
  console.log(`[Notifications] registered: ${p.config.channelId} (heartbeat=${p.config.heartbeat.enabled}, alerts=${p.config.alerts.enabled})`);
  return { ok: true, payload: { channelId: p.config.channelId } };
};

// ============== notifications.unregister ==============

/**
 * 渠道注销通知配置
 */
const handleNotificationsUnregister: Handler = async (params, _client, ctx) => {
  if (!ctx.notificationRouter) {
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, "notification router not available") };
  }
  const p = params as { channelId?: string } | undefined;
  if (!p?.channelId) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "channelId required") };
  }
  ctx.notificationRouter.unregister(p.channelId);
  console.log(`[Notifications] unregistered: ${p.channelId}`);
  return { ok: true, payload: { channelId: p.channelId } };
};

// ============== notifications.config ==============

/**
 * 查询/更新通知配置
 * GET: 返回所有渠道的通知配置
 * UPDATE: 更新指定渠道的通知配置
 */
const handleNotificationsConfig: Handler = async (params, _client, ctx) => {
  if (!ctx.notificationRouter) {
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, "notification router not available") };
  }
  const p = params as { action?: string; channelId?: string; config?: ChannelNotificationConfig } | undefined;
  const action = p?.action ?? "get";

  if (action === "get") {
    const channelId = p?.channelId;
    if (channelId) {
      const config = ctx.notificationRouter.getConfig(channelId);
      return { ok: true, payload: config ?? null };
    }
    return { ok: true, payload: ctx.notificationRouter.getAllConfigs() };
  }

  if (action === "update" && p?.config) {
    ctx.notificationRouter.register(p.config);
    console.log(`[Notifications] updated config: ${p.config.channelId}`);
    return { ok: true, payload: { channelId: p.config.channelId } };
  }

  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "invalid action or missing config") };
};

// ============== heartbeat.trigger ==============
// 手动触发一次心跳（运维/自测用；正常由定时器或时段切换触发）
const handleHeartbeatTrigger: Handler = async (params, _client, ctx) => {
  const p = params as { reason?: string } | undefined;
  const reason = p?.reason || 'manual';
  try {
    ctx.agent.getHeartbeat().requestNow(reason);
    return { ok: true, payload: { triggered: true, reason } };
  } catch (e) {
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, (e as Error).message) };
  }
};

// ============== notifications.deliver ==============
// 供运行时主动投递：心跳简报 / 时段变更（渠道侧只负责把 chat 事件转成 IM 消息）
const handleNotificationsDeliver: Handler = async (params, _client, ctx) => {
  if (!ctx.notificationRouter) {
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, "notification router not available") };
  }
  const p = params as { kind?: string; text?: string; session?: string; from?: string; to?: string } | undefined;
  if (!p?.kind) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "kind required") };
  }

  if (p.kind === "heartbeat" && p.text) {
    ctx.notificationRouter.routeHeartbeat(p.text, p.session);
    return { ok: true, payload: { kind: p.kind } };
  }
  if (p.kind === "session" && p.from && p.to) {
    ctx.notificationRouter.routeSessionChange(p.from, p.to);
    return { ok: true, payload: { kind: p.kind } };
  }

  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "unsupported kind or missing fields") };
};

// ============== trader.balance ==============

/**
 * 直接查询真实股票账户资产（EastMoneyTrader.getBalance）。
 * 用于驾驶舱「真实账户」资产概览：不经 paper 回退，账户未配置/未登录即硬失败，
 * 由调用方（server_app）将错误透传给前端。
 */
const handleTraderBalance: Handler = async () => {
  try {
    const trader = await EastMoneyTrader.getInstance();
    const balances = await trader.getBalance();
    const b = balances[0];
    if (!b) {
      return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, "真实账户无资金数据") };
    }
    return {
      ok: true,
      payload: {
        totalAssets: b.assetBalance,
        availableFunds: b.enableBalance,
        positionMarketValue: b.marketValue,
        currentBalance: b.currentBalance,
        frozenBalance: b.frozenBalance,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, `真实账户资产查询失败: ${msg}`) };
  }
};

// ============== trader.liquidate ==============

/**
 * 一键清仓真实账户：遍历真实持仓逐只提交卖出委托（EastMoneyTrader 实盘 + 交易时段闸）。
 * 仅供 server_app live 模式调用；paper 模式清仓由 server_app 本地虚拟处理。
 */
const handleTraderLiquidate: Handler = async () => {
  try {
    const router = await TradeRouter.getInstance();
    const result = await router.liquidate('一键清仓');
    return { ok: true, payload: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, `清仓失败: ${msg}`) };
  }
};

// ============== trader.status ==============

/**
 * 返回 hotwave 交易路由的实盘就绪状态（TRADE_MODE + LIVE_TRADE_ENABLED）+ 交易时段。
 * 供前端判断「真实账户」是否可用（实盘未配置时禁用真实清仓，避免点了才知道不行）。
 */
const handleTraderStatus: Handler = async () => {
  try {
    const router = await TradeRouter.getInstance();
    const s = router.status();
    return {
      ok: true,
      payload: {
        mode: s.mode,
        liveReady: s.liveReady,
        inTradingSession: s.inTradingSession,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, `交易状态查询失败: ${msg}`) };
  }
};

// ============== chat.abort / agent.state / approval.* (P2 控制面) ==============

/**
 * 中断当前 run：手机端「停止」按钮。
 * 语义：终止 agent loop，保留已生成内容，返回 aborted 标记。
 */
const handleChatAbort: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string; runId?: string } | undefined;
  const sessionKey = p?.sessionKey || "main";
  const target = p?.runId || activeRuns.get(sessionKey)?.runId;
  if (!target) {
    return { ok: true, payload: { aborted: false, reason: "no active run" } };
  }
  ctx.agent.abort(target);
  console.log("[Gateway/handler] chat.abort sessionKey=" + sessionKey + " runId=" + target);
  return { ok: true, payload: { aborted: true, runId: target, sessionKey } };
};

/** Agent 运行态：供手机端状态卡展示 */
const handleAgentState: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string } | undefined;
  const sessionKey = p?.sessionKey || "main";
  const active = activeRuns.get(sessionKey);
  return {
    ok: true,
    payload: {
      status: approvalBridge.size > 0 ? "waiting_approval" : active ? "running" : "idle",
      sessionKey,
      runId: active?.runId,
      startedAt: active?.startedAt,
      pendingApprovals: approvalBridge.size,
      gatewayUptimeMs: Date.now() - ctx.startedAt,
    },
  };
};

/** 待审批列表 */
const handleApprovalList: Handler = async () => {
  return { ok: true, payload: { approvals: approvalBridge.list() } };
};

/** 远程审批决策：allow-once | allow-always | deny */
const handleApprovalDecide: Handler = async (params) => {
  const p = params as { requestId?: string; decision?: string } | undefined;
  if (!p?.requestId) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "requestId required") };
  }
  const d = p.decision;
  if (d !== "allow-once" && d !== "allow-always" && d !== "deny") {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "decision must be allow-once | allow-always | deny") };
  }
  const handled = approvalBridge.decide(p.requestId, d as ApprovalDecision);
  if (!handled) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "approval not found (expired or decided)") };
  }
  return { ok: true, payload: { requestId: p.requestId, decision: d } };
};

// ============== 方法注册表 ==============

export const handlers: Record<string, Handler> = {
  "connect": handleConnect,
  "chat.send": handleChatSend,
  "chat.history": handleChatHistory,
  "sessions.list": handleSessionsList,
  "sessions.reset": handleSessionsReset,
  "chat.abort": handleChatAbort,
  "agent.state": handleAgentState,
  "approval.list": handleApprovalList,
  "approval.decide": handleApprovalDecide,
  "health": handleHealth,
  "monitor.subscribe": handleMonitorSubscribe,
  "monitor.unsubscribe": handleMonitorUnsubscribe,
  "monitor.status": handleMonitorStatus,
  "monitor.instruct": handleMonitorInstruct,
  "monitor.search_stocks": handleMonitorSearchStocks,
  "trader.balance": handleTraderBalance,
  "trader.liquidate": handleTraderLiquidate,
  "trader.status": handleTraderStatus,
  "notifications.register": handleNotificationsRegister,
  "notifications.unregister": handleNotificationsUnregister,
  "notifications.config": handleNotificationsConfig,
  "heartbeat.trigger": handleHeartbeatTrigger,
  "notifications.deliver": handleNotificationsDeliver,

};
