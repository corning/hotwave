/**
 * 微信频道适配器
 *
 * 使用微信 iLink Bot API 通过 HTTP long-poll 模式连接。
 * 个人号机器人接口，支持私聊和群聊消息处理。
 *
 * 架构:
 *   微信 ──► iLink Bot API (HTTP long-poll) ──► GatewayClient ──► Gateway ──► Agent
 *     ◄── POST sendMessage ◄── onEvent("chat") ◄──
 *
 * 环境变量:
 *   WECHAT_BOT_TOKEN=xxxxxxxx
 *   WECHAT_BOT_BASE_URL=https://xxxxxxxxx
 *   WECHAT_BOT_CDN_URL=https://cdn-bot.weixin.qq.com (optional)
 *   WECHAT_BOT_ACCOUNT_ID=wx_xxxx (optional, for multi-account)
 */

import { type Channel, type ChannelConfig, type ChannelStatus, sessionKeyFor as skf } from "./types.js";
import { GatewayClient } from "../runtime/rpc/client.js";
import type { EventFrame } from "../runtime/rpc/protocol.js";
import type { ChannelNotificationConfig } from "../runtime/rpc/notification-router.js";

// ============== 类型 ==============

export type WechatChannelOptions = {
  botToken: string;
  baseUrl?: string;
  accountId?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
};

// ============== 微信 API 返回类型 ==============

interface WechatUpdateItem {
  msgId: string;
  talkerId: string;
  talkerName?: string;
  content?: string;
  contentType: number; // 1=text, 3=image, 34=voice, 47=emoji, 49=app/card
  conversationId?: string;
  conversationType: number; // 1=private, 2=group
  createTime: number;
  wxid?: string;
  groupId?: string;
}

interface WechatGetUpdatesResponse {
  ret: number;
  data: {
    item: WechatUpdateItem[];
    continueId?: number;
  };
  msg?: string;
}

interface WechatSendMessageResponse {
  ret: number;
  data?: { msgId?: string };
  msg?: string;
}

// ============== 常量 ==============

const CHANNEL_ID = "wechat";
const CHANNEL_LABEL = "微信";
const POLL_TIMEOUT_SEC = 35;
const POLL_INTERVAL_MS = 1000; // 轮询间隔
const WX_MAX_LENGTH = 4000;
const RECONNECT_DELAY_MS = 10000;

// ============== Channel 实现 ==============

export class WechatChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly label = CHANNEL_LABEL;

  private gwClient: GatewayClient | null = null;
  private baseUrl = "";
  private botToken = "";
  private accountId = "";
  private lastMsgId = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionChats = new Map<string, { talkerId: string; groupId?: string }>();
  private abortController: AbortController | null = null;
  private _running = false;
  private _connected = false;
  private _lastEventAt: number | null = null;
  private _lastError: string | null = null;

  /** 通知目标列表（从 config 读取，启动时注册到 NotificationRouter） */
  private notificationTargets: string[] = [];

  async start(config: ChannelConfig): Promise<void> {
    this.botToken = config.botToken as string;
    if (!this.botToken) throw new Error("Wechat botToken is required");

    this.baseUrl = (config.baseUrl as string) ?? "https://wxbot.weixin.qq.com";
    this.accountId = (config.accountId as string) ?? "";

    // 读取通知目标（逗号分隔的 wxid 列表）
    const notifyTargets = (config.notificationTargets as string | undefined)
      ?? process.env.WECHAT_NOTIFY_TARGETS;
    this.notificationTargets = notifyTargets
      ? notifyTargets.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    const gwUrl = (config.gatewayUrl as string) ?? "ws://localhost:18789";
    const gwToken = config.gatewayToken as string | undefined;

    // 1. 连接 Gateway
    this.gwClient = new GatewayClient({
      url: gwUrl,
      token: gwToken,
      onEvent: (evt: EventFrame) => this._onGatewayEvent(evt),
      onConnect: (hello) => {
        console.log(`\x1b[2m  gateway reconnected (v${hello.protocol})\x1b[0m`);
        this._connected = true;
      },
    });

    const hello = await this.gwClient.connect();
    this._connected = true;

    // 2. 验证连接并获取机器人信息
    try {
      const status = await this._apiGet<{ ret: number; data?: { wxid?: string } }>(
        "/api/status",
      );
      if (status.ret !== 0) {
        console.warn(`\x1b[33m  wechat status check returned: ${JSON.stringify(status)}\x1b[0m`);
      }
    } catch {
      console.log(`\x1b[2m  wechat: awaiting login...\x1b[0m`);
    }

    // 3. 启动 long-poll 循环
    this.abortController = new AbortController();
    this._pollLoop(this.abortController.signal).catch((err) => {
      this._lastError = (err as Error).message;
      console.error(`\x1b[33m  wechat poll loop error: ${(err as Error).message}\x1b[0m`);
    });

    this._running = true;

    // 注册通知配置到 Gateway NotificationRouter
    if (this.notificationTargets.length > 0) {
      try {
        const notifConfig: ChannelNotificationConfig = {
          channelId: CHANNEL_ID,
          heartbeat: {
            enabled: true,
            phases: ["pre_open", "morning", "afternoon", "post_market"],
            targets: this.notificationTargets,
          },
          alerts: {
            enabled: true,
            levels: ["warning", "critical"],
            targets: this.notificationTargets,
          },
          sessionChange: {
            enabled: true,
            targets: this.notificationTargets,
          },
        };
        await this.gwClient.request("notifications.register", { config: notifConfig });
        console.log(`\x1b[2m  notifications: ${this.notificationTargets.join(", ")}\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[33m  notification register failed: ${(err as Error).message}\x1b[0m`);
      }
    }

    console.log(`\n\x1b[36m●\x1b[0m \x1b[1m微信 Channel\x1b[0m`);
    console.log(`\x1b[2m  gateway: ${gwUrl} (v${hello.protocol})\x1b[0m`);
    console.log(`\x1b[2m  mode: long-poll every ${POLL_INTERVAL_MS}ms\x1b[0m`);
    console.log(`\x1b[2m  commands: /reset /health (in chat)\x1b[0m`);
    console.log(`\x1b[2m  Ctrl+C to stop\x1b[0m\n`);
  }

  async stop(): Promise<void> {
    this._running = false;
    this._connected = false;
    this.abortController?.abort();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.sessionChats.clear();
    this.gwClient?.close();
    this.gwClient = null;
  }

  getStatus(): ChannelStatus {
    return {
      id: this.id,
      label: this.label,
      connected: this._connected,
      running: this._running,
      lastEventAt: this._lastEventAt,
      lastError: this._lastError,
    };
  }

  // ============== 内部方法 ==============

  private _sessionKeyFor(id: string): string {
    return skf(CHANNEL_ID, id);
  }

  /** 微信 API GET 请求 */
  private async _apiGet<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}?token=${encodeURIComponent(this.botToken)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wechat api GET ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** 微信 API POST 请求 */
  private async _apiPost<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}?token=${encodeURIComponent(this.botToken)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`wechat api POST ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** Long-poll 消息轮询循环 */
  private async _pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this._running) {
      try {
        const updates = await this._apiGet<WechatGetUpdatesResponse>(
          `/openapi/getupdates?lastId=${this.lastMsgId}&timeout=${POLL_TIMEOUT_SEC}`,
        );

        if (updates.ret === 0 && updates.data?.item) {
          for (const item of updates.data.item) {
            if (Number(item.msgId) > this.lastMsgId) {
              this.lastMsgId = Number(item.msgId);
            }
            await this._handleUpdate(item).catch((err) => {
              console.error(`\x1b[33m  wechat handle msg ${item.msgId}: ${(err as Error).message}\x1b[0m`);
            });
          }
        } else if (updates.ret === -14) {
          // Token 过期，等待
          this._lastError = "token expired, waiting 10s";
          console.warn(`\x1b[33m  wechat token expired, retrying in ${RECONNECT_DELAY_MS / 1000}s\x1b[0m`);
          await this._sleep(RECONNECT_DELAY_MS);
          continue;
        } else if (updates.ret !== 0) {
          this._lastError = updates.msg ?? `api error ${updates.ret}`;
        }
      } catch (err) {
        this._lastError = (err as Error).message;
        console.error(`\x1b[33m  wechat poll error: ${(err as Error).message}\x1b[0m`);
        if (!signal.aborted) await this._sleep(POLL_INTERVAL_MS);
      }
    }
  }

  /** 处理单条消息更新 */
  private async _handleUpdate(item: WechatUpdateItem): Promise<void> {
    // 只处理文本消息
    if (item.contentType !== 1 || !item.content) return;

    const text = item.content.trim();
    const isGroup = item.conversationType === 2;

    // 确定会话 key: 私聊用 talkerId, 群聊用 groupId
    const identifier = isGroup ? (item.groupId ?? item.talkerId) : item.talkerId;
    const sessionKey = this._sessionKeyFor(identifier);

    this.sessionChats.set(sessionKey, {
      talkerId: item.talkerId,
      groupId: isGroup ? item.groupId : undefined,
    });

    this._lastEventAt = Date.now();

    // 处理命令
    if (text.startsWith("/reset")) {
      try {
        await this.gwClient!.request("sessions.reset", { sessionKey });
        await this._sendMessage(item.talkerId, "会话已重置");
      } catch (err) {
        await this._sendMessage(item.talkerId, `重置失败: ${(err as Error).message}`);
      }
      return;
    }

    if (text.startsWith("/health")) {
      try {
        const h = await this.gwClient!.request<{ uptimeMs: number; clients: number }>("health");
        await this._sendMessage(
          item.talkerId,
          `Gateway 运行时间: ${Math.round(h.uptimeMs / 1000)}s, 客户端数: ${h.clients}`,
        );
      } catch (err) {
        await this._sendMessage(item.talkerId, `健康检查失败: ${(err as Error).message}`);
      }
      return;
    }

    // 发送给 Agent
    try {
      await this.gwClient!.request("chat.send", { sessionKey, message: text });
    } catch (err) {
      this._lastError = (err as Error).message;
      await this._sendMessage(item.talkerId, `Error: ${(err as Error).message}`);
    }
  }

  /** 发送消息到微信 */
  private async _sendMessage(talkerId: string, text: string): Promise<void> {
    // 分片发送长消息
    let remaining = text;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, WX_MAX_LENGTH);
      remaining = remaining.slice(WX_MAX_LENGTH);

      try {
        const res = await this._apiPost<WechatSendMessageResponse>("/openapi/sendMessage", {
          toWxid: talkerId,
          content: chunk,
          contentType: 1,
          accountId: this.accountId || undefined,
        });
        if (res.ret !== 0) {
          console.error(`\x1b[33m  wechat send error: ${res.msg ?? res.ret}\x1b[0m`);
          return;
        }
      } catch (err) {
        console.error(`\x1b[33m  wechat send error: ${(err as Error).message}\x1b[0m`);
        return;
      }
    }
  }

  /** 处理 Gateway 事件回调 */
  private _onGatewayEvent(evt: EventFrame): void {
    if (evt.event !== "chat") return;
    const p = evt.payload as {
      sessionKey?: string;
      state?: string;
      text?: string;
      error?: string;
      source?: string;
    };
    if (!p.sessionKey?.startsWith(`${CHANNEL_ID}:`)) return;

    const chat = this.sessionChats.get(p.sessionKey);
    if (!chat) return;

    this._lastEventAt = Date.now();

    if (p.state === "final") {
      if (p.text) this._sendMessage(chat.talkerId, p.text).catch(console.error);
    } else if (p.state === "error") {
      this._lastError = p.error ?? "unknown";
      this._sendMessage(chat.talkerId, `Error: ${p.error ?? "unknown"}`).catch(console.error);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============== 工厂函数 ==============

export async function startWechatChannel(opts: WechatChannelOptions) {
  const ch = new WechatChannel();
  await ch.start({
    botToken: opts.botToken,
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
  });
  return {
    close: () => ch.stop(),
    getStatus: () => ch.getStatus(),
  };
}
