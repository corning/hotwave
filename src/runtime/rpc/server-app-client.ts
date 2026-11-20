/**
 * hotwave -> server_app 长连接客户端（反向调用模式）
 *
 * hotwave 用 TRADE_BINDING_ID/SECRET 主动连 server_app WS server（:18791），建立长连接。
 * server_app 通过该连接反向下发 RPC（chat.send、monitor.*、trader.balance），本 client 收 req
 * -> dispatch 到 handlers 注册表（复用 handlers.ts:710）-> 回 res + 流式 event。
 *
 * 替代旧 server_app 主动连 hotwave gateway 的反向依赖：方向反转--hotwave=client 主动连
 * server_app(server)，server_app 利用该连接反向调用 hotwave。
 *
 * 认证：server_app 发 connect.challenge -> 本 client 回 connect req（bindingId/Secret/nonce）
 *       -> server_app verifyBinding -> res ok。
 *
 * chat.send 流式：handleChatSend 立即返回 ACK res，agent.run 异步执行，
 * 通过 ctx.broadcast("chat", delta/final/thinking) 推流式 event 到 server_app。
 * 本 client 的 serverAppCtx.broadcast 实现 = 推 event 到 server_app（ws.send）。
 */

import WebSocket from "ws";
import crypto from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type RequestFrame,
} from "./protocol.js";
import {
  handlers,
  type GwClient,
  type HandlerContext,
} from "./handlers.js";
import { approvalBridge } from "./control-bridge.js";

export type ServerAppClientOptions = {
  /** server_app WS server URL，默认 ws://localhost:18791 */
  url: string;
  /** hotwave 绑定凭证（用户在 APP/admin 生成后配置到 .env） */
  bindingId: string;
  bindingSecret: string;
  /** 复用 gateway ctx（agent/monitorManager/notificationRouter） */
  ctx: HandlerContext;
  /** 认证成功回调（含重连） */
  onConnect?: () => void;
};

const HANDSHAKE_TIMEOUT_MS = 10_000;
const KEEPALIVE_TIMEOUT_MS = 300_000; // 300s 无消息视为僵死，触发重连。对齐 STREAM_IDLE_TIMEOUT_MS（glm-5.2 思考久，90s 易误杀）
const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
/** 连接存活超过它才算"站得住"：只有稳定连接才复位退避，避免被顶掉时陷入 1s 重连死循环 */
const STABLE_CONNECT_MS = 10_000;

export class ServerAppClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 1000;
  private seq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventMs = Date.now();
  /** 上次 status_change 的状态 key（running|session|items 数量），去重同步重复触发 */
  private lastStatusKey = "";
  /** 上一次认证成功的时间（判断连接存活时长，决定是否复位退避） */
  private connectedAt = 0;
  /** 连续被 4002 顶替的次数（正常稳定连接后清零） */
  private replacedStreak = 0;
  /** 被顶替的告警只打一次，避免刷屏 */
  private warnedReplace = false;

  /** 代表 server_app 连接的 GwClient（handler 用 client.socket.send 推单 client） */
  private gwClient: GwClient;
  /** server-app-client 自己的 ctx（broadcast 推 server_app，其余复用 gateway ctx） */
  private serverAppCtx: HandlerContext;

  constructor(private opts: ServerAppClientOptions) {
    this.gwClient = {
      id: "server-app",
      socket: {
        send: (data: string) => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
        },
        close: (code?: number, reason?: string) => {
          this.ws?.close(code, reason);
        },
        bufferedAmount: 0,
      },
      authed: true,
    };
    this.serverAppCtx = {
      ...opts.ctx,
      broadcast: (event, payload) => this.sendEvent(event, payload),
      clients: new Set([this.gwClient]),
      nonces: new Map(),
      startedAt: Date.now(),
    };

    // 包装 monitorManager 回调：alert/statusChange 既走主 ctx.broadcast（IM channels/CLI），
    // 又定向上行 server_app（monitor.alert/monitor.status_change event）。
    // 不把 gwClient 加入主 ctx.clients，避免 chat/monitor.status_change 重复推送。
    const mm = opts.ctx.monitorManager;
    if (mm) {
      const origAlert = mm.onAlert;
      const origStatus = mm.onStatusChange;
      mm.onAlert = (alert) => {
        origAlert?.(alert);
        this.sendEvent("monitor.alert", alert);
      };
      mm.onStatusChange = (status) => {
        origStatus?.(status);
        // 去重：monitor.* handler 与 monitorManager.notifyStatusChange 同步触发重复 status_change，
        // 按 running+tradingSession+items 数量 比较，状态未变则跳过（真实变化仍上行）。
        const s = status as any;
        const key = `${s?.running ?? ""}|${s?.tradingSession ?? ""}|${Array.isArray(s?.itemsList) ? s.itemsList.length : 0
          }`;
        if (key === this.lastStatusKey) return;
        this.lastStatusKey = key;
        this.sendEvent("monitor.status_change", status);
      };
    }
  }

  /** 上行 event 到 server_app（chat delta/monitor.alert 等） */
  private sendEvent(event: string, payload: unknown) {
    if (event !== 'tick') console.log('[ServerAppClient] 上行事件:', event);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: "event", event, payload, seq: ++this.seq })
      );
    }
  }

  private respond(
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string }
  ) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "res", id, ok, payload, error }));
    }
  }

  /** 主动连 server_app + binding 认证 */
  async connect(): Promise<void> {
    if (this.closed) return;
    this.ws = new WebSocket(this.opts.url);
    let handshakeResolved = false;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(new Error("handshake timeout"));
        }
      }, HANDSHAKE_TIMEOUT_MS);

      this.ws!.on("open", () => {
        console.log(`[ServerAppClient] 已连 ${this.opts.url}`);
      });

      this.ws!.on("message", (raw) => {
        let parsed: any;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        this.lastEventMs = Date.now();

        // connect.challenge -> 回 connect req（bindingId/Secret/nonce）
        if (parsed.type === "event" && parsed.event === "connect.challenge") {
          const nonce = parsed.payload?.nonce;
          this.ws!.send(
            JSON.stringify({
              type: "req",
              id: crypto.randomUUID(),
              method: "connect",
              params: {
                bindingId: this.opts.bindingId,
                bindingSecret: this.opts.bindingSecret,
                nonce,
              },
            })
          );
          return;
        }

        // 认证成功 res（首个 res）
        if (parsed.type === "res" && parsed.ok && !handshakeResolved) {
          handshakeResolved = true;
          clearTimeout(timer);
          // 只有上一次连接"活得够久"才复位退避；被 4002 顶掉时保持指数退避，
          // 否则退避会一直停在 1s，形成 1s 一次的重连循环（日志刷屏）。
          if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_CONNECT_MS) {
            this.backoffMs = 1000;
            this.replacedStreak = 0;
            this.warnedReplace = false;
          }
          this.connectedAt = Date.now();
          console.log("[ServerAppClient] 认证成功，已建立长连接");
          // 控制面：审批事件经本连接上行到 server_app（再经 SSE 推给手机）
          approvalBridge.setEventSink((event, payload) => this.sendEvent(event, payload));
          this.startKeepalive();
          this.opts.onConnect?.();
          resolve();
          return;
        }

        // server_app 下发 req -> dispatch handlers（connect 除外，认证已由 server_app 端处理）
        if (parsed.type === "req" && parsed.method !== "connect") {
          this.dispatchReq(parsed as RequestFrame).catch((err) => {
            console.error("[ServerAppClient] dispatchReq 异常:", err);
          });
        }
      });

      this.ws!.on("close", (code, reason) => {
        clearTimeout(timer);
        this.stopKeepalive();
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(new Error(`handshake closed: ${code}`));
          return;
        }
        console.log(`[ServerAppClient] 连接关闭: ${code} ${reason || ""}`);
        // 4002 replaced：server_app 同一个 binding 只保留最新一条连接。若本机有两个 hotwave 实例
        // （如 launchd 常驻 + pnpm dev）共用 TRADE_BINDING_ID，就会互相顶替、无限重连。
        if (code === 4002) this.noteReplaced();
        // 断开时撤销审批事件通道，避免向空连接 sendEvent
        approvalBridge.setEventSink(undefined);
        this.scheduleReconnect();
      });

      this.ws!.on("error", (err) => {
        clearTimeout(timer);
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(new Error(`connect error: ${err.message}`));
        }
      });
    }).catch((err) => {
      if (!this.closed) {
        console.warn(`[ServerAppClient] 连接失败: ${err.message}`);
        this.scheduleReconnect();
      }
      throw err;
    });
  }

  /** 收 server_app req -> 查 handlers 注册表 -> 调用 -> 回 res */
  private async dispatchReq(req: RequestFrame) {
    const handler = handlers[req.method];
    if (!handler) {
      this.respond(
        req.id,
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`)
      );
      return;
    }
    try {
      const result = await handler(req.params, this.gwClient, this.serverAppCtx);
      this.respond(req.id, result.ok, result.payload, result.error);
    } catch (err) {
      this.respond(
        req.id,
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, String(err))
      );
    }
  }

  /** 应用层 keepalive：90s 无消息视为僵死，主动断开触发重连 */
  private startKeepalive() {
    this.stopKeepalive();
    this.lastEventMs = Date.now();
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastEventMs > KEEPALIVE_TIMEOUT_MS) {
        console.warn("[ServerAppClient] 90s 无消息，主动断开触发重连");
        this.ws?.close(4001, "keepalive timeout");
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** 被新连接顶替（4002）：正常应被单实例锁拦住，出现即说明还有旧版本进程在跑 */
  private noteReplaced() {
    this.replacedStreak += 1;
    if (!this.warnedReplace && this.replacedStreak >= 2) {
      this.warnedReplace = true;
      console.warn(
        "[ServerAppClient] 连接被新连接顶替（4002 replaced by new connection）：同一个 binding（TRADE_BINDING_ID）" +
          "还有另一个 hotwave 进程在跑。运行时已强制单实例（src/common/instance-lock.ts），" +
          "出现本条多半是旧版本/绕过锁的进程：用 lsof -nP -iTCP:8791 -sTCP:LISTEN 找到并停掉它，" +
          "或重启 launchd 常驻（launchctl kickstart -k gui/$(id -u)/com.hotpursuit.runtime）。",
      );
    }
  }

  /** A2 指数退避自动重连：1s->2s->...->30s 上限 + jitter */
  private scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs + Math.floor(Math.random() * 500);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    console.log(`[ServerAppClient] ${delay}ms 后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        /* scheduleReconnect 已在 connect catch 内触发 */
      });
    }, delay);
  }

  close() {
    this.closed = true;
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * 若配 TRADE_BINDING_ID/SECRET，启动 server-app-client 连 server_app。
 * 在 gateway server ctx 就绪后调用。未配置则跳过（独立隐私模式）。
 */
export async function startServerAppClientIfConfigured(
  ctx: HandlerContext
): Promise<ServerAppClient | null> {
  const bindingId = process.env.TRADE_BINDING_ID || "";
  const bindingSecret = process.env.TRADE_BINDING_SECRET || "";
  if (!bindingId || !bindingSecret) {
    console.log("[ServerAppClient] TRADE_BINDING_ID/SECRET 未配置，跳过（独立隐私模式）");
    return null;
  }
  const url = process.env.TRADE_API_WS_URL || "ws://localhost:18791";
  const client = new ServerAppClient({ url, bindingId, bindingSecret, ctx });
  client.connect().catch((e) => {
    console.warn("[ServerAppClient] 启动连接失败:", (e as Error).message);
  });
  return client;
}
