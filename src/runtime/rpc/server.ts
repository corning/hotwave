/**
 * Gateway 服务端
 *
 * 核心模式:
 * 1. Challenge-Response 握手
 * 2. 方法路由: RequestFrame.method → handlers[method]
 * 3. Pub/Sub 广播: broadcast(event, payload) → seq 递增 → 背压控制
 * 4. 心跳: 30s tick → 慢消费者检测
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentLike } from "../contracts.js";
// session-key 模块已移除，内联判定
function isHeartbeatSessionKey(key: string): boolean { return key.startsWith("_heartbeat"); }
import {
  type RequestFrame, type ResponseFrame, type EventFrame,
  isRequestFrame,
  ErrorCodes, errorShape, newId,
  TICK_INTERVAL_MS, MAX_BUFFERED_BYTES, HANDSHAKE_TIMEOUT_MS,
} from "./protocol.js";
import { handlers, type GwClient, type BroadcastFn, type HandlerContext } from "./handlers.js";
import { startServerAppClientIfConfigured } from "./server-app-client.js";
import { MonitorManager } from "./monitor-manager.js";
import { NotificationRouter } from "./notification-router.js";
import { currentTradingSession } from "./trading-session.js";
import { startMonitorEngine, type MonitorEngine } from "./monitor-engine.js";
import { resolveWorkspaceDir } from "../../common/paths.js";
import { DEFAULT_MONITOR_INDICES } from "./protocol.js";
import { recordHeartbeatReport } from "../../trader/trade-store.js";
import type { Usage } from "@mariozechner/pi-ai";
// auto-trade.ts 已移除：交易决策改由 LLM 读 STRATEGY.md 自主完成（heartbeat / alert 触发）

/** LLM 决策单次 run 超时（agent.run/__internalChat）：5min。超时 abort LLM fetch + 工具执行。 */
const LLM_DECISION_TIMEOUT_MS = 5 * 60 * 1000;
/** mutex acquire 超时：6min（比 run 多 1min，run 先超时释放，mutex 仅作兜底）。 */
const MUTEX_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * LLM 决策串行锁：heartbeat / alert / schedule 三类 LLM 调用互斥排队，
 * 避免单实例 agent 并发破坏 runAbortControllers / 事件流 / session 写入（实盘防重复下单/决策错乱）。
 * acquire 返回等待时长 + 是否并发，用于记录触发原因写入 heartbeat_reports.trigger_reason。
 *
 * 超时兜底：promise chain 下"跳过"会断链（resolveNext 不调，后续等待者永久 hang）。
 * 改为保存 currentRelease，超时替前一个持有者调 release()，让链推进。release 幂等，
 * 原持有者（被强制释放后）之后调自己 release 无副作用。配合 agent.run timeoutMs（先超时释放），
 * mutex 超时仅在 run timeout 机制失效时触发。
 */
class LlmDecisionMutex {
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;
  /** 当前持有者的 release 函数（供下一个等待者超时强制释放） */
  private currentRelease: (() => void) | null = null;

  async acquire(
    timeoutMs: number = MUTEX_TIMEOUT_MS,
  ): Promise<{ release: () => void; waitedMs: number; contended: boolean }> {
    const waitStart = Date.now();
    const wasBusy = this.busy;
    const prev = this.tail;
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => {
      resolveNext = r;
    });
    this.tail = prev.then(() => next);
    this.busy = true;

    // 兜底：前一个持有者卡死（run-level timeout 失效时）则替它释放，让链推进
    const timer = setTimeout(() => {
      if (this.currentRelease) {
        console.error(
          `[LlmDecisionMutex] acquire 等待 ${timeoutMs}ms 超时，强制释放前一个持有者`,
        );
        this.currentRelease();
      }
    }, timeoutMs);

    await prev;
    clearTimeout(timer);
    const waitedMs = Date.now() - waitStart;

    let released = false;
    const release = () => {
      if (released) return; // 幂等：原持有者被强制释放后再调无副作用
      released = true;
      this.busy = false;
      this.currentRelease = null;
      resolveNext();
    };
    this.currentRelease = release;

    return { release, waitedMs, contended: wasBusy };
  }
}

// ============== 类型 ==============

export type GatewayServerOptions = {
  port?: number;
  token?: string;
  agent: AgentLike;
  /** 主动唤醒配置（A 股交易日定时检查） */
  heartbeat?: {
    /** 是否启用 */
    enabled?: boolean;
    /** 检查间隔（毫秒），默认 30 分钟 */
    intervalMs?: number;
    /** 活跃时间窗口，默认 A 股交易时段 09:00-16:00 */
    activeHours?: { start: string; end: string };
  };
  /** 实时监控引擎配置 */
  monitor?: {
    /** 是否启用监控 */
    enabled?: boolean;
    /** 告警冷却（毫秒），默认 60 秒 */
    alertCooldownMs?: number;
  };
};

export type GatewayServer = {
  close: (opts?: { restartExpectedMs?: number }) => void;
  port: number;
  /** 供同进程的 HTTP 层复用（单进程架构：runtime 内嵌网关） */
  ctx: HandlerContext;
  monitorManager: MonitorManager;
  /** 内置监控引擎（替代 Python 瘦客户端；随网关启动/停止） */
  monitorEngine: MonitorEngine;
  notificationRouter: NotificationRouter;
  startedAt: number;
};

// ============== 广播器 ==============

/**
 * 广播策略:
 * - seq 全局递增
 * - dropIfSlow: 非关键事件（tick、delta）跳过慢消费者而非断开
 * - 强制关闭: 关键事件时，慢消费者直接断开防止内存泄漏
 */
function createBroadcaster(clients: Set<GwClient>): BroadcastFn {
  let seq = 0;
  return (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => {
    const frame: EventFrame = { type: "event", event, payload, seq: ++seq };
    const data = JSON.stringify(frame);
    for (const c of clients) {
      if (!c.authed) continue;
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        // 非关键事件：跳过慢消费者（tick/delta）
        continue;
      }
      if (slow) {
        // 关键事件：强制关闭慢消费者（关闭码 1008）
        c.socket.close(1008, "slow consumer");
        continue;
      }
      try { c.socket.send(data); } catch { /* 忽略已断开的连接 */ }
    }
  };
}

// ============== 启动服务 ==============

export async function startGatewayServer(opts: GatewayServerOptions): Promise<GatewayServer> {
  const requestedPort = opts.port ?? 18789;
  const clients = new Set<GwClient>();
  const nonces = new Map<string, string>();
  const broadcast = createBroadcaster(clients);
  const startedAt = Date.now();
  const agent = opts.agent;
  let unsubHeartbeat: (() => void) | undefined;

  // LLM 决策串行锁：heartbeat/schedule 两类 LLM 调用互斥排队（实盘防并发破坏）
  // 告警已不唤醒 LLM（仅展示+落库），故 mutex 现仅约束 heartbeat 与定时任务
  const llmDecisionMutex = new LlmDecisionMutex();

  // NotificationRouter: 系统消息路由到 IM 渠道
  // 通知路由：纯内存，渠道进程启动时通过 notifications.register 自注册
  const notificationRouter = new NotificationRouter({ broadcast });

  // MonitorManager: 监控引擎管理
  const monitorManager = new MonitorManager({
    alertCooldownMs: opts.monitor?.alertCooldownMs ?? 60_000,
    onAlert: (alert) => {
      // 广播到监控页 SSE（APP 监控页展示）
      broadcast("monitor.alert", alert);

      // 既有链路缺失的一环：把告警按 notifications 配置路由到 IM 渠道
      try {
        notificationRouter.routeAlert(alert);
      } catch (e) {
        console.error("[Monitor] routeAlert failed:", (e as Error).message);
      }
      console.log(`[Monitor] ALERT: ${alert.item.symbol} level=${alert.level} msg=${alert.message}`);

      // 告警不唤醒 LLM：仅广播到监控页 SSE + 上行落库（monitor_alerts 表）。
      // 交易决策统一由心跳执行（定时 + session_change），避免告警浅决策与心跳重复下单、
      // 破坏策略一致性。critical 异动的即时响应通过缩短心跳间隔（10min）弥补。
    },
    onStatusChange: (status) => {
      broadcast("monitor.status_change", status);
    },
  });

  // 注册默认监控指数；MONITOR_INDEX_LIST（逗号分隔）可覆盖，如 sh000001,sz399001,sz399006
  const indexList = (process.env.MONITOR_INDEX_LIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (indexList.length) {
    monitorManager.subscribe(
      indexList.map((symbol) => ({ id: 'index-' + symbol.replace(/[^a-z0-9]/gi, ''), type: 'index' as const, symbol, interval: 3 })),
    );
  } else {
    monitorManager.subscribe(DEFAULT_MONITOR_INDICES);
  }

  // 初始交易时段按本机时钟推断（不是 "idle"）：否则盘中重启会被误判为时段切换
  monitorManager.setTradingSession(currentTradingSession());

  const ctx: HandlerContext = {
    agent,
    broadcast,
    clients,
    token: opts.token,
    nonces,
    startedAt,
    monitorManager,
    notificationRouter,
  };

  // 启动 server-app-client：若配 TRADE_BINDING_ID/SECRET，hotwave 主动连 server_app
  // 建立长连接（反向调用模式），server_app 通过该连接下发 RPC。未配置则跳过（独立隐私模式）。
  // 内置监控引擎：清单/告警直接走 MonitorManager，行情走 server_app（失败回落腾讯），
  // 不再需要单独运行的 Python 瘦客户端进程。
  const engineClient = { id: "monitor-engine", socket: null as unknown as GwClient["socket"], authed: true };
  const monitorEngine = startMonitorEngine({
    enabled: opts.monitor?.enabled ?? false,
    intervalMs: Number(
      process.env.MONITOR_INTERVAL_MS || (Number(process.env.MONITOR_INTERVAL || 5) * 1000),
    ),
    pricePct: Number(process.env.MONITOR_PRICE_PCT || 3.0),
    volumeRatio: Number(process.env.MONITOR_VOLUME_RATIO || 2.0),
    getItems: () => monitorManager.getItems(),
    raiseAlert: (alert) => monitorManager.raiseAlert(alert),
    session: () => currentTradingSession(),
    onSessionChange: (from, to) => {
      // 复用 monitor.instruct：IM 通知 + 关键时点触发心跳，与旧瘦客户端上报语义一致
      void handlers["monitor.instruct"]({ instruction: "session_change", context: { from, to } }, engineClient, ctx)
        .catch((e) => console.warn("[Monitor] session_change 处理失败:", (e as Error).message));
    },
  });
  monitorManager.setRunning(monitorEngine.status().enabled);

  startServerAppClientIfConfigured(ctx).catch((e) => {
    console.warn("[Gateway] server-app-client 启动失败:", (e as Error).message);
  });

  // HTTP 服务
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "hotwave-gateway", uptimeMs: Date.now() - startedAt }));
  });

  // WebSocket 服务
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    const connId = newId();
    const client: GwClient = { id: connId, socket, authed: false };
    clients.add(client);

    // 1. 发送 challenge（connect.challenge 事件）
    const nonce = newId();
    nonces.set(connId, nonce);
    send(socket, { type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() }, seq: 0 });

    // 2. 握手超时
    const handshakeTimer = setTimeout(() => {
      if (!client.authed) {
        socket.close(4000, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    // 3. 消息处理（socket.on("message")）
    socket.on("message", async (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(raw)); } catch { return; }

      if (!isRequestFrame(parsed)) return;
      const req = parsed as RequestFrame;

      // 未认证时只允许 connect 方法
      if (!client.authed && req.method !== "connect") {
        respond(socket, req.id, false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "not authenticated"));
        return;
      }

      // 方法路由
      const handler = handlers[req.method];
      if (!handler) {
        respond(socket, req.id, false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`));
        return;
      }

      try {
        const result = await handler(req.params, client, ctx);
        respond(socket, req.id, result.ok, result.payload, result.error);
        if (req.method === "connect" && result.ok) {
          clearTimeout(handshakeTimer);
        }
      } catch (err) {
        respond(socket, req.id, false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      }
    });

    // 4. 连接关闭清理
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      clients.delete(client);
      nonces.delete(connId);
    });

    socket.on("error", () => {
      clients.delete(client);
      nonces.delete(connId);
    });
  });

  // Tick 定时器（30s tick 广播，可丢弃）
  const tickTimer = setInterval(() => {
    broadcast("tick", { ts: Date.now() }, { dropIfSlow: true });
  }, TICK_INTERVAL_MS);

  // 监听
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    const bindHost = process.env.HOTWAVE_GW_HOST || "127.0.0.1";
  httpServer.listen(requestedPort, bindHost, () => resolve());
  });
  const address = httpServer.address() as AddressInfo | null;
  const port = address?.port ?? requestedPort;

  // ============== NotificationRouter 初始化 ==============

  await notificationRouter.load(); // 兼容调用点（当前为空实现）

  // ============== Heartbeat 主动唤醒（A 股交易员定时任务） ==============

  if (opts.heartbeat?.enabled) {
    const hbInterval = opts.heartbeat.intervalMs ?? 10 * 60 * 1000;
    const activeHours = opts.heartbeat.activeHours ?? { start: "09:00", end: "16:00" };
    // 最小间隔保护（bug-263）：两次 heartbeat LLM 调用间隔 < 此值且非 session_change 则跳过，
    // 避免 interval 到点时上次 LLM 还在跑 -> HeartbeatWake coalesce 250ms 续跑导致密集唤醒
    // （生产观测到 1-2min 间隔，远低于 intervalMs 10min）。session_change 不受限（时段转换需实时）。
    const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5min
    let lastHeartbeatLlmAt = 0;

    // 配置 HeartbeatManager
    agent.getHeartbeat().updateConfig({
      enabled: true,
      intervalMs: hbInterval,
      activeHours,
    });

    // 永久订阅 agent 事件：heartbeat 简报路由到 IM 渠道 + 直写 server_app heartbeat_reports 表。
    // 简报已彻底移出 chat 体系：不再 broadcast("chat", _heartbeat_)，避免串扰/截断用户聊天流。
    unsubHeartbeat = agent.subscribe((event: any) => {
      if ("sessionKey" in event && isHeartbeatSessionKey(event.sessionKey as string)) {
        const evt = event as Record<string, unknown>;
        if (evt.type === "message_end") {
          const text = evt.text as string;
          // 路由心跳报告到已注册的 IM 渠道（实时推送）
          notificationRouter.routeHeartbeat(text, monitorManager.getStatus().tradingSession);
          // 落库改由 startHeartbeat 回调直接处理（带 usage + text），
          // 避免 message_end（run 内部完成时触发）与 decisionMetaByRun.set（await run 返回后）
          // 的时序竞争导致 usage 丢失（DB 印证：heartbeat total_tokens 恒为 0）。
        }
      }
    });

    // 注册 heartbeat 回调：读取 HEARTBEAT.md 内容，驱动 LLM 做市场分析
    // 盘中阶段额外注入 STRATEGY.md + 持仓快照，驱动 LLM 自动交易决策
    agent.startHeartbeat?.(async (content: string, reason: string) => {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();

      // 每天 09:00-09:10 盘前首次 heartbeat 清空 _heartbeat_ session，避免跨天累积（bug-263）。
      // 曾 4 天累积 288k tokens 导致 LLM context 溢出；每日重置 + compaction 阈值降低双保险。
      if (hour === 9 && minute < 10) {
        await agent.clearSession("_heartbeat_").catch(() => {});
        console.log("[heartbeat] 盘前清空 _heartbeat_ session（每日重置，bug-263）");
      }

      // 根据时间段构造不同的分析提示
      let phase = "";
      let inSession = false;
      if (hour < 9 || (hour === 9 && minute < 25)) {
        phase = "盘前准备";
      } else if (hour < 11 || (hour === 11 && minute < 30)) {
        phase = "上午盘中监控";
        inSession = true;
      } else if (hour < 13) {
        phase = "午间休市";
      } else if (hour < 15) {
        phase = "下午盘中监控";
        inSession = true;
      } else {
        phase = "盘后复盘";
      }

      // 盘中：注入 STRATEGY.md，LLM 作为决策者自主买卖（strategy_tag=heartbeat）
      let tradeSection = "";
      if (inSession) {
        let strategy = "";
        try {
          strategy = await fs.readFile(path.join(resolveWorkspaceDir(), "STRATEGY.md"), "utf8");
        } catch {
          // STRATEGY.md 不存在则忽略
        }
        const mode = process.env.TRADE_MODE === "live" ? "实盘" : "模拟盘";
        tradeSection = `

【交易决策 · ${mode}】你是交易决策者（非仅分析）。按工作区 STRATEGY.md 策略执行：
1. 调 trader_mode 自检交易模式与风控状态
2. 调 trader_balance / trader_position 查当前资金与持仓
3. 调 finance_kline 取关注标的（monitor 自选 + 持仓）行情与均线/技术指标
4. 按 STRATEGY.md 买卖规则评估信号（止损/止盈/买入条件）
5. 触发信号则调 trader_buy / trader_sell 下单（strategy_tag=heartbeat，模拟盘按真实资金纪律）
6. 输出：各标的状态 + 已下/未下决策与理由 + 风险提示

${strategy ? `--- STRATEGY.md ---\n${strategy}\n--- end ---` : "（未找到 STRATEGY.md，仅做行情分析）"}`;
      }

      const heartbeatMessage = `【${phase} · ${now.toLocaleString("zh-CN", { hour12: false })}】

根据以下市场监控清单执行例行检查：

${content}${tradeSection}

${inSession ? "盘中阶段：按上方 STRATEGY.md 策略自主决策买卖（trader_buy/trader_sell, strategy_tag=heartbeat）。不可仅回复\"正常\"--即使无新增信号也请简要说明各标的状态与决策。" : "请根据当前可知的市场信息，简要说明是否有需要关注的情况。"}`;

      // 最小间隔保护（bug-263）：非 session_change 触发且距上次 LLM < 5min 则跳过。
      // 放在 clearSession + heartbeatMessage 构造之后，确保盘前清空 session 不被 skip。
      // 返回 {text:undefined} 走 runOnce 的"空回复=HEARTBEAT_OK"分支 -> scheduleNext（10min 后），
      // 不触发 retry，不死循环。session_change（时段转换）不受限，保证盘前/开盘/收盘实时决策。
      if (
        reason !== "session_change" &&
        lastHeartbeatLlmAt &&
        Date.now() - lastHeartbeatLlmAt < MIN_HEARTBEAT_INTERVAL_MS
      ) {
        console.log(
          `[heartbeat] 跳过：距上次 LLM ${Date.now() - lastHeartbeatLlmAt}ms < ${MIN_HEARTBEAT_INTERVAL_MS}ms（reason=${reason}，bug-263 min-interval）`,
        );
        return { text: undefined };
      }

      const hbMutex = await llmDecisionMutex.acquire();
      let hbText: string | undefined;
      try {
        // 即将调 LLM，先记录时间（超时/失败也计入间隔，避免 coalesce 续跑不受限导致密集）
        lastHeartbeatLlmAt = Date.now();
        const hbResult = await agent.run("_heartbeat_", heartbeatMessage, {
          timeoutMs: LLM_DECISION_TIMEOUT_MS,
          // 心跳要自查账户/持仓/多标的行情再决策，给 4 轮工具预算；
          // 超出后内核自动撤工具并要求结论，避免 6 轮全是工具调用 -> 空文本不落库
          maxToolTurns: Number(process.env.HEARTBEAT_MAX_TOOL_TURNS || 4),
        });
        hbText = hbResult.text;
        const hbTriggerReason = hbMutex.contended
          ? `心跳定时（与上一次心跳并发，等待 ${hbMutex.waitedMs}ms）`
          : `心跳定时（${hbInterval / 60000}min）`;
        // 直接落库（带 usage + text），不依赖 message_end 的 decisionMetaByRun
        // （message_end 在 run 内部完成时触发，早于 await agent.run 返回，此时 usage 尚未就绪）
        if (hbResult.text) {
          recordHeartbeatReport(hbResult.runId, hbResult.text, {
            source: "heartbeat",
            usage: hbResult.usage,
            triggerReason: hbTriggerReason,
          }).then((inserted) => {
            if (inserted) {
              console.log(`[Heartbeat] 简报落库成功: runId=${hbResult.runId}, tokens=${hbResult.usage?.totalTokens ?? 0}, len=${hbResult.text.length}`);
            } else {
              console.warn(`[Heartbeat] 简报未入库（runId=${hbResult.runId}，重复 runId 或绑定凭证失效）`);
            }
          }).catch((err) => {
            console.warn(`[Heartbeat] 简报落库异常:`, (err as Error).message);
          });
        } else {
          // 跑到一半没有文本产出：以前完全静默 → 表现为"心跳只跑了一次"
          console.warn(`[Heartbeat] 本轮无输出（turns=${hbResult.turns}, tools=${hbResult.toolCalls}），未落库`);
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[heartbeat] LLM 运行错误:`, msg);
        // 失败留痕：写一行 source=error，APP 简报中心能看到"本轮心跳失败"，不再凭空消失
        recordHeartbeatReport('hb-fail-' + Date.now(), '[心跳失败] ' + msg, {
          source: 'error',
          triggerReason: '心跳失败（' + reason + '）',
        }).catch(() => { /* best-effort */ });
      } finally {
        hbMutex.release();
      }
      // LLM 播报与决策落库 heartbeat_reports + 推 IM；此处不额外触发简报
      return { text: hbText };
    });

    console.log(`  heartbeat: ${activeHours.start}-${activeHours.end} every ${hbInterval / 60000}min\x1b[0m`);
  }

  // 优雅关闭
  const close = (closeOpts?: { restartExpectedMs?: number }) => {
    if (opts.heartbeat?.enabled) {
      agent.stopHeartbeat?.();
    }
    if (unsubHeartbeat) unsubHeartbeat();
    broadcast("shutdown", {
      reason: "server closing",
      restartExpectedMs: closeOpts?.restartExpectedMs ?? null,
    });
    monitorEngine.stop();
    clearInterval(tickTimer);
    for (const c of clients) {
      try { c.socket.close(1012, "service restart"); } catch { }
    }
    clients.clear();
    wss.close();
    httpServer.close();
  };

  return { close, port, ctx, monitorManager, notificationRouter, monitorEngine, startedAt };
}

// ============== 帮助函数 ==============

function send(socket: WebSocket, frame: EventFrame | ResponseFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function respond(socket: WebSocket, id: string, ok: boolean, payload?: unknown, error?: import("./protocol.js").ErrorShape): void {
  send(socket, { type: "res", id, ok, payload, error });
}
