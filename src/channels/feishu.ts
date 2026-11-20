/**
 * 飞书频道适配器
 *
 * 使用 @larksuiteoapi/node-sdk 的 WebSocket 长连接模式连接飞书开放平台。
 * 无需公网 webhook URL，适合开发/内网部署。
 *
 * 架构:
 *   飞书 ──► WSClient(长连接) ──► GatewayClient ──► Gateway ──► Agent
 *     ◄── im.message.create ◄── onEvent("chat") ◄──
 *
 * 环境变量:
 *   FEISHU_APP_ID=cli_xxxxxxxx
 *   FEISHU_APP_SECRET=xxxxxxxx
 *   FEISHU_VERIFICATION_TOKEN=xxxxxxxx (optional)
 *   FEISHU_ENCRYPT_KEY=xxxxxxxx (optional)
 */

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { EventFrame } from "../runtime/rpc/protocol.js";
import { GatewayClient } from "../runtime/rpc/client.js";
import { type Channel, type ChannelConfig, type ChannelStatus, sessionKeyFor as skf, stripMarkdown } from "./types.js";
import type { ChannelNotificationConfig } from "../runtime/rpc/notification-router.js";

// ============== 类型 ==============

export type FeishuChannelOptions = {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
};

// ============== 常量 ==============

const CHANNEL_ID = "feishu";
const CHANNEL_LABEL = "飞书";
const FEISHU_MAX_LENGTH = 8000;

// ============== Feishu 事件类型（SDK 类型） ==============

interface FeishuMessageEventData {
  sender: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { union_id?: string; user_id?: string; open_id?: string };
      name: string;
      tenant_key?: string;
    }>;
  };
}

// ============== Channel 实现 ==============

export class FeishuChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly label = CHANNEL_LABEL;

  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private gwClient: GatewayClient | null = null;
  private sessionChats = new Map<string, { chatId: string }>();
  private _running = false;
  private _connected = false;
  private _lastEventAt: number | null = null;
  private _lastError: string | null = null;

  /** 通知目标列表 */
  private notificationTargets: string[] = [];

  async start(config: ChannelConfig): Promise<void> {
    const appId = config.appId as string;
    const appSecret = config.appSecret as string;
    if (!appId || !appSecret) throw new Error("Feishu appId and appSecret are required");

    // 读取通知目标
    const notifyTargets = (config.notificationTargets as string | undefined)
      ?? process.env.FEISHU_NOTIFY_TARGETS;
    this.notificationTargets = notifyTargets
      ? notifyTargets.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    const verificationToken = config.verificationToken as string | undefined;
    const encryptKey = config.encryptKey as string | undefined;
    const gwUrl = (config.gatewayUrl as string) ?? "ws://localhost:18789";
    const gwToken = config.gatewayToken as string | undefined;

    // 1. 创建 Lark Client
    this.client = new Client({ appId, appSecret });

    // 2. 连接 Gateway
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

    // 3. 创建 EventDispatcher + WSClient
    const dispatcher = new EventDispatcher({
      encryptKey,
      verificationToken,
    }).register({
      "im.message.receive_v1": async (data: any) => {
        try {
          // 注意: WSClient 回调的数据是扁平结构，message/sender 在顶层而非 data.event 下
          console.log(`\x1b[2m  [feishu] callback fired — keys: ${Object.keys(data||{}).join(",")}\x1b[0m`);
          if (!data?.message) {
            console.log(`\x1b[33m  [feishu] callback fired but no .message field — this may be a non-message event\x1b[0m`);
            return;
          }
          console.log(`\x1b[2m  [feishu] im.message.receive_v1 — chat_type=${data.message?.chat_type ?? "?"} msg_type=${data.message?.message_type ?? "?"}\x1b[0m`);
          await this._handleMessage(data as FeishuMessageEventData);
        } catch (err) {
          this._lastError = (err as Error).message;
          console.error(`\x1b[33m  feishu message error: ${(err as Error).message}\x1b[0m`);
        }
      },
    });

    this.wsClient = new WSClient({
      appId,
      appSecret,
      autoReconnect: true,
      onReady: () => {
        console.log(`\x1b[2m  feishu ws connected\x1b[0m`);
      },
      onError: (err) => {
        this._lastError = err.message;
        console.error(`\x1b[33m  feishu ws error: ${err.message}\x1b[0m`);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });

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
            levels: ["info", "warning", "critical"],
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
    console.log(`\n\x1b[36m\u25cf\x1b[0m \x1b[1m飞书 Channel\x1b[0m`);
    console.log(`\x1b[2m  gateway: ${gwUrl} (v${hello.protocol})\x1b[0m`);
    console.log(`\x1b[2m  app_id: ${appId}\x1b[0m`);
    console.log(`\x1b[2m  mode: websocket long-connection\x1b[0m`);
    console.log(`\x1b[2m  commands: /reset /health (in chat)\x1b[0m`);
    console.log(`\x1b[2m  Ctrl+C to stop\x1b[0m\n`);
  }

  async stop(): Promise<void> {
    this._running = false;
    this._connected = false;
    this.sessionChats.clear();
    this.wsClient = null;
    this.client = null;
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

  /** 统一的 session key */
  private _sessionKeyFor(id: string): string {
    return skf(CHANNEL_ID, id);
  }

  /** 处理飞书消息事件 */
  private async _handleMessage(eventData: FeishuMessageEventData): Promise<void> {
    const { sender, message } = eventData;
    console.log(`\x1b[2m  [feishu] _handleMessage — sender_type=${sender.sender_type} chat_type=${message.chat_type} msg_type=${message.message_type}\x1b[0m`);

    // 忽略系统事件（sender_type 不是 "user"）
    if (sender.sender_type !== "user") {
      console.log(`\x1b[2m  [feishu] _handleMessage — skip (sender_type=${sender.sender_type} !== "user")\x1b[0m`);
      return;
    }

    // 解析消息内容
    const text = this._extractText(message);
    console.log(`\x1b[2m  [feishu] extracted text (${text.length} chars): ${text.slice(0, 50)}...\x1b[0m`);
    if (!text) return;

    // 确定 session key: 私聊用 open_id, 群聊用 chat_id
    const openId = sender.sender_id?.open_id;
    const isGroup = message.chat_type === "group" || message.chat_type === "p2p";
    const identifier = message.chat_type === "p2p"
      ? (openId ?? message.chat_id)
      : message.chat_id;
    const sessionKey = this._sessionKeyFor(identifier);

    // 群聊中只响应 @机器人 的消息
    if (message.chat_type !== "p2p") {
      console.log(`\x1b[2m  [feishu] group msg — mentions=${message.mentions?.length ?? 0}\x1b[0m`);
      if (!message.mentions || message.mentions.length === 0) return;
      // 必须有 @mention（SDK 不会传入机器人自己的 mention，只传用户的）
    }

    // 记录会话映射
    this.sessionChats.set(sessionKey, {
      chatId: message.chat_id,
    });

    this._lastEventAt = Date.now();

    // 处理命令
    if (text.startsWith("/reset")) {
      try {
        await this.gwClient!.request("sessions.reset", { sessionKey });
        await this._sendReply(message.chat_id, "会话已重置");
      } catch (err) {
        await this._sendReply(message.chat_id, `重置失败: ${(err as Error).message}`);
      }
      return;
    }

    if (text.startsWith("/health")) {
      try {
        const h = await this.gwClient!.request<{ uptimeMs: number; clients: number }>("health");
        await this._sendReply(
          message.chat_id,
          `Gateway 运行时间: ${Math.round(h.uptimeMs / 1000)}s, 客户端数: ${h.clients}`,
        );
      } catch (err) {
        await this._sendReply(message.chat_id, `健康检查失败: ${(err as Error).message}`);
      }
      return;
    }

    // 发送给 Agent
    try {
      console.log(`\x1b[2m  [feishu] → gwClient.request("chat.send") sessionKey=${sessionKey}\x1b[0m`);
      await this.gwClient!.request("chat.send", { sessionKey, message: text });
      console.log(`\x1b[2m  [feishu] ← chat.send ACK received\x1b[0m`);
    } catch (err) {
      this._lastError = (err as Error).message;
      await this._sendReply(message.chat_id, `Error: ${(err as Error).message}`);
    }
  }

  /** 从消息中提取纯文本 */
  private _extractText(message: FeishuMessageEventData["message"]): string {
    if (message.message_type === "text") {
      try {
        const parsed = JSON.parse(message.content);
        return parsed.text ?? "";
      } catch {
        return message.content;
      }
    }
    return "";
  }

  /** 发送回复到飞书 */
  private async _sendReply(chatId: string, text: string): Promise<void> {
    text = stripMarkdown(text);
    console.log(`\x1b[2m  [feishu] _sendReply → chatId=${chatId} textLen=${text.length}\x1b[0m`);
    if (!this.client) {
      console.log(`\x1b[33m  [feishu] _sendReply failed — client is null\x1b[0m`);
      return;
    }

    // 分片发送长消息
    let remaining = text;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, FEISHU_MAX_LENGTH);
      remaining = remaining.slice(FEISHU_MAX_LENGTH);

      try {
        await this.client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          },
        });
      } catch (err) {
        console.error(`\x1b[33m  feishu send error: ${(err as Error).message}\x1b[0m`);
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
    console.log(`\x1b[2m  [feishu] _onGatewayEvent — state=${p.state} sessionKey=${p.sessionKey?.slice(0,20)} textLen=${p.text?.length ?? 0}\x1b[0m`);
    if (!p.sessionKey?.startsWith(`${CHANNEL_ID}:`)) {
      console.log(`\x1b[2m  [feishu] _onGatewayEvent — skip (not feishu session) key=${p.sessionKey?.slice(0,20)}\x1b[0m`);
      return;
    }

    // 从 sessionChats 映射获取 chatId（用户主动发消息场景）
    let chatId: string | undefined = this.sessionChats.get(p.sessionKey)?.chatId;

    // 如果 sessionChats 中没有记录（系统推送场景），
    // 直接从 sessionKey 解析 identifier 作为 receive_id
    if (!chatId) {
      const identifier = p.sessionKey.slice(`${CHANNEL_ID}:`.length);
      if (identifier) {
        chatId = identifier;
        // 反向注册到 sessionChats
        this.sessionChats.set(p.sessionKey, { chatId });
      } else {
        console.log(`\x1b[2m  [feishu] _onGatewayEvent — skip (cannot resolve target from ${p.sessionKey})\x1b[0m`);
        return;
      }
    }

    this._lastEventAt = Date.now();

    if (p.state === "final") {
      if (p.text) this._sendReply(chatId, p.text).catch(console.error);
    } else if (p.state === "error") {
      this._lastError = p.error ?? "unknown";
      this._sendReply(chatId, `Error: ${p.error ?? "unknown"}`).catch(console.error);
    }
  }
}

// ============== 工厂函数 ==============

export async function startFeishuChannel(opts: FeishuChannelOptions) {
  const ch = new FeishuChannel();
  await ch.start({
    appId: opts.appId,
    appSecret: opts.appSecret,
    verificationToken: opts.verificationToken,
    encryptKey: opts.encryptKey,
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
  });
  return {
    close: () => ch.stop(),
    getStatus: () => ch.getStatus(),
  };
}
