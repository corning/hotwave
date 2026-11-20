/**
 * 钉钉频道适配器
 *
 * 使用 dingtalk-stream SDK 的 Stream Mode WebSocket 长连接模式。
 * 无需公网 webhook URL，适合开发/内网部署。
 *
 * 架构:
 *   钉钉 ──► DWClient (Stream Mode) ──► GatewayClient ──► Gateway ──► Agent
 *     ◄── callback webhook POST ◄── onEvent("chat") ◄──
 *
 * 环境变量:
 *   DINGTALK_CLIENT_ID=dingxxxxxxxx
 *   DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxx
 */

import { type Channel, type ChannelConfig, type ChannelStatus, sessionKeyFor as skf, stripMarkdown } from "./types.js";
import type { ChannelNotificationConfig } from "../runtime/rpc/notification-router.js";
import { GatewayClient } from "../runtime/rpc/client.js";
import type { EventFrame } from "../runtime/rpc/protocol.js";

// ============== 类型 ==============

export type DingtalkChannelOptions = {
  clientId: string;
  clientSecret: string;
  gatewayUrl?: string;
  gatewayToken?: string;
};

/** 钉钉消息回调内容 */
interface DingtalkCallbackData {
  /** 会话 webhook，用于回复消息 */
  sessionWebhook?: string;
  /** 发送者 ID */
  senderId?: string;
  senderNick?: string;
  /** 会话 ID */
  conversationId?: string;
  /** 1=单聊, 2=群聊 */
  conversationType?: string;
  /** 消息 ID */
  msgId?: string;
  /** 消息类型 */
  msgtype?: string;
  /** 文本内容 */
  text?: { content?: string };
  /** @ 用户列表 */
  atUsers?: Array<{ dingtalkId?: string }>;
  /** 机器人自身信息 */
  robotCode?: string;
  /** 是否在 @ 列表中 */
  isInAtList?: boolean;
  /** 创建时间 */
  createdAt?: string;
}

// ============== 常量 ==============

const CHANNEL_ID = "dingtalk";
const CHANNEL_LABEL = "钉钉";
const DT_MAX_LENGTH = 8000;

// ============== Channel 实现 ==============

export class DingtalkChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly label = CHANNEL_LABEL;

  private gwClient: GatewayClient | null = null;
  private dwClient: any = null;
  private sessionChats = new Map<string, { conversationId: string; webhook: string | null }>();
  private _running = false;
  private _connected = false;
  private _lastEventAt: number | null = null;
  private _lastError: string | null = null;

  /** 通知目标列表 */
  private notificationTargets: string[] = [];

  async start(config: ChannelConfig): Promise<void> {
    const clientId = config.clientId as string;
    const clientSecret = config.clientSecret as string;
    if (!clientId || !clientSecret) throw new Error("Dingtalk clientId and clientSecret are required");

    // 读取通知目标
    const notifyTargets = (config.notificationTargets as string | undefined)
      ?? process.env.DINGTALK_NOTIFY_TARGETS;
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

    // 2. 导入 dingtalk-stream DWClient
    let DWClient: any;
    try {
      const dts = await import("dingtalk-stream");
      DWClient = dts.DWClient;
    } catch {
      throw new Error(
        "dingtalk-stream SDK not found. Install it: npm install dingtalk-stream",
      );
    }

    // 3. 创建并配置 DWClient
    this.dwClient = new DWClient({ clientId, clientSecret });

    // 注册回调监听（接收 IM 消息）
    this.dwClient.registerCallbackListener(
      "/v1.0/im/bot/messages/get",
      (res: any) => {
        try {
          let rawData = res?.data;
          // dingtalk-stream 回调 data 可能是 JSON 字符串
          if (typeof rawData === "string") {
            try { rawData = JSON.parse(rawData); } catch { }
          }
          const data = rawData as DingtalkCallbackData | undefined;
          if (data) {
            const preview = data.text?.content?.slice(0, 60) ?? "(no text)";
            const chatType = data.conversationType === "2" ? "群聊" : "单聊";
            console.log(`\x1b[36m  [dingtalk] 收到消息: ${chatType} sender=${data.senderNick ?? data.senderId ?? "?"} msgType=${data.msgtype ?? "?"} text="${preview}"\x1b[0m`);
            this._handleMessage(data).catch((err) => {
              this._lastError = (err as Error).message;
              console.error(`\x1b[33m  [dingtalk] 消息处理异常: ${(err as Error).message}\x1b[0m`);
            });
          } else {
            console.log(`\x1b[2m  [dingtalk] 收到回调但 data 为空\x1b[0m`);
          }
        } catch (err) {
          this._lastError = (err as Error).message;
          console.error(`\x1b[33m  [dingtalk] 回调解析异常: ${(err as Error).message}\x1b[0m`);
        }
      },
    );

    // 4. 连接
    await this.dwClient.connect();


    // 注册通知配置到 Gateway NotificationRouter
    if (this.notificationTargets.length > 0) {
      try {
        const notifConfig: ChannelNotificationConfig = {
          channelId: CHANNEL_ID,
          heartbeat: {
            enabled: true,
            phases: ["post_market"],
            targets: this.notificationTargets,
          },
          alerts: {
            enabled: true,
            levels: ["critical"],
            targets: this.notificationTargets,
          },
          sessionChange: {
            enabled: false,
            targets: [],
          },
        };
        await this.gwClient.request("notifications.register", { config: notifConfig });
        console.log(`\x1b[2m  notifications: ${this.notificationTargets.join(", ")}\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[33m  notification register failed: ${(err as Error).message}\x1b[0m`);
      }
    }

    this._running = true;

    console.log(`\n\x1b[36m\u25cf\x1b[0m \x1b[1m钉钉 Channel\x1b[0m`);
    console.log(`\x1b[2m  gateway: ${gwUrl} (v${hello.protocol})\x1b[0m`);
    console.log(`\x1b[2m  client_id: ${clientId}\x1b[0m`);
    console.log(`\x1b[2m  mode: stream mode\x1b[0m`);
    console.log(`\x1b[2m  commands: /reset /health (in chat)\x1b[0m`);
    console.log(`\x1b[2m  Ctrl+C to stop\x1b[0m\n`);
  }

  async stop(): Promise<void> {
    this._running = false;
    this._connected = false;
    this.sessionChats.clear();
    try { this.dwClient?.disconnect(); } catch { }
    this.dwClient = null;
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

  /** 处理钉钉消息 */
  private async _handleMessage(data: DingtalkCallbackData): Promise<void> {
    const text = data.text?.content?.trim();
    if (!text) {
      console.log(`\x1b[2m  [dingtalk] 消息无文本内容，跳过\x1b[0m`);
      return;
    }

    const senderId = data.senderId ?? "unknown";
    const isGroup = data.conversationType === "2"; // 2 = 群聊

    // 群聊中只响应 @bot 的消息
    if (isGroup && !data.isInAtList) {
      console.log(`\x1b[2m  [dingtalk] 群聊消息未@机器人，跳过: "${text.slice(0, 40)}"\x1b[0m`);
      return;
    }

    const sessionKey = this._sessionKeyFor(senderId);
    console.log(`\x1b[36m  [dingtalk] 处理消息 senderId=${senderId} sessionKey=${sessionKey} text="${text.slice(0, 60)}"\x1b[0m`);

    this.sessionChats.set(sessionKey, {
      conversationId: data.conversationId ?? senderId,
      webhook: data.sessionWebhook ?? null,
    });

    this._lastEventAt = Date.now();

    // 处理命令
    if (text.startsWith("/reset")) {
      try {
        await this.gwClient!.request("sessions.reset", { sessionKey });
        await this._sendReply(sessionKey, "会话已重置");
      } catch (err) {
        await this._sendReply(sessionKey, `重置失败: ${(err as Error).message}`);
      }
      return;
    }

    if (text.startsWith("/health")) {
      try {
        const h = await this.gwClient!.request<{ uptimeMs: number; clients: number }>("health");
        await this._sendReply(
          sessionKey,
          `Gateway 运行时间: ${Math.round(h.uptimeMs / 1000)}s, 客户端数: ${h.clients}`,
        );
      } catch (err) {
        await this._sendReply(sessionKey, `健康检查失败: ${(err as Error).message}`);
      }
      return;
    }

    // 发送给 Agent
    try {
      console.log(`\x1b[2m  [dingtalk] → 发送 chat.send 到 Gateway sessionKey=${sessionKey}\x1b[0m`);
      const sendResult = await this.gwClient!.request("chat.send", { sessionKey, message: text });
      console.log(`\x1b[2m  [dingtalk] ← chat.send 返回: ${JSON.stringify(sendResult).slice(0, 100)}\x1b[0m`);
    } catch (err) {
      this._lastError = (err as Error).message;
      console.error(`\x1b[33m  [dingtalk] chat.send 失败: ${(err as Error).message}\x1b[0m`);
      await this._sendReply(sessionKey, `Error: ${(err as Error).message}`);
    }
  }

  /** 发送回复（优先走 webhook） */
  private async _sendReply(sessionKey: string, text: string): Promise<void> {
    text = stripMarkdown(text);
    const chat = this.sessionChats.get(sessionKey);
    if (!chat || !chat.webhook) {
      console.error(`\x1b[33m  [dingtalk] 无 webhook 可回复 session=${sessionKey}\x1b[0m`);
      return;
    }

    const preview = text.slice(0, 40);
    console.log(`\x1b[2m  [dingtalk] → 回复消息 sessionKey=${sessionKey} text="${preview}..." (共${text.length}字符)\x1b[0m`);

    // 分片发送长消息
    let remaining = text;
    let chunkIndex = 0;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, DT_MAX_LENGTH);
      remaining = remaining.slice(DT_MAX_LENGTH);

      const body = JSON.stringify({
        msgtype: "text",
        text: { content: chunk },
      });

      try {
        const resp = await fetch(chat.webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        console.log(`\x1b[2m  [dingtalk] ← webhook 响应: ${resp.status} (分片 ${chunkIndex})\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[33m  [dingtalk] webhook 请求失败: ${(err as Error).message}\x1b[0m`);
        return;
      }
      chunkIndex++;
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

    this._lastEventAt = Date.now();
    const textPreview = p.text ? p.text.slice(0, 40) : "(无文本)";
    console.log(`\x1b[2m  [dingtalk] Gateway 事件: sessionKey=${p.sessionKey} state=${p.state} text="${textPreview}"\x1b[0m`);

    if (p.state === "final") {
      if (p.text) this._sendReply(p.sessionKey, p.text).catch(console.error);
    } else if (p.state === "error") {
      this._lastError = p.error ?? "unknown";
      console.error(`\x1b[33m  [dingtalk] Gateway 返回错误: ${p.error ?? "unknown"}\x1b[0m`);
      this._sendReply(p.sessionKey, `Error: ${p.error ?? "unknown"}`).catch(console.error);
    } else if (p.state === "delta") {
      console.log(`\x1b[2m  [dingtalk] 收到 delta 中间增量 (忽略，等待 final)\x1b[0m`);
    }
  }
}

// ============== 工厂函数 ==============

export async function startDingtalkChannel(opts: DingtalkChannelOptions) {
  const ch = new DingtalkChannel();
  await ch.start({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
  });
  return {
    close: () => ch.stop(),
    getStatus: () => ch.getStatus(),
  };
}
