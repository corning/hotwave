/**
 * Telegram 频道适配器
 *
 * 架构:
 *   Telegram ──► Bot(grammy) ──► GatewayClient ──► Gateway ──► Agent
 *     ◄──── bot.api.sendMessage ◄──── onEvent("chat") ◄────
 */

import { Bot } from "grammy";
import { GatewayClient } from "../runtime/rpc/client.js";
import type { EventFrame } from "../runtime/rpc/protocol.js";
import { type Channel, type ChannelConfig, type ChannelStatus, sessionKeyFor as skf } from "./types.js";
import type { ChannelNotificationConfig } from "../runtime/rpc/notification-router.js";

// ============== 类型 ==============

export type TelegramChannelOptions = {
  botToken: string;
  gatewayUrl?: string;
  gatewayToken?: string;
};

// ============== 常量 ==============

const TG_MAX_LENGTH = 4096;
const TYPING_INTERVAL_MS = 5000;
const CHANNEL_ID = "telegram";
const CHANNEL_LABEL = "Telegram";

// ============== Channel 类实现 ==============

export class TelegramChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly label = CHANNEL_LABEL;

  private bot: Bot | null = null;
  private client: GatewayClient | null = null;
  private sessionChats = new Map<string, number>();
  private typingTimers = new Map<number, ReturnType<typeof setInterval>>();
  private _running = false;
  private _connected = false;
  private _lastEventAt: number | null = null;
  private _lastError: string | null = null;

  /** 通知目标列表（从 config 或环境变量读取，启动时注册到 NotificationRouter） */
  private notificationTargets: string[] = [];

  async start(config: ChannelConfig): Promise<void> {
    const botToken = config.botToken as string;
    if (!botToken) throw new Error("Telegram botToken is required");

    // 读取通知目标（逗号分隔的 chatId 列表）
    // 优先从 config 读取，其次从环境变量 TELEGRAM_NOTIFY_TARGETS 读取
    const notifyTargets = (config.notificationTargets as string | undefined)
      ?? process.env.TELEGRAM_NOTIFY_TARGETS;
    this.notificationTargets = notifyTargets
      ? notifyTargets.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    this.bot = new Bot(botToken);
    const gwUrl = (config.gatewayUrl as string) ?? "ws://localhost:18789";
    const gwToken = config.gatewayToken as string | undefined;

    this.client = new GatewayClient({
      url: gwUrl,
      token: gwToken,
      onEvent: (evt: EventFrame) => this._onGatewayEvent(evt),
      onConnect: (hello) => {
        console.log(`\x1b[2m  gateway reconnected (v${hello.protocol})\x1b[0m`);
        this._connected = true;
      },
    });

    const hello = await this.client.connect();
    this._connected = true;

    // 预先获取 bot 信息
    await this.bot.init();
    const botInfo = this.bot.botInfo;

    // 全局错误处理
    this.bot.catch((err) => {
      this._lastError = err.message;
      console.error(`\x1b[33m  bot error: ${err.message}\x1b[0m`);
    });

    // Bot 命令
    this.bot.command("start", (ctx) =>
      ctx.reply("Hi! Send me a message and I'll reply via the AI agent."),
    );

    this.bot.command("reset", async (ctx) => {
      const sessionKey = this._sessionKeyFor(ctx.chat.id);
      try {
        await this.client!.request("sessions.reset", { sessionKey });
        await ctx.reply("Session reset.");
      } catch (err) {
        await ctx.reply(`Reset failed: ${(err as Error).message}`);
      }
    });

    this.bot.command("health", async (ctx) => {
      try {
        const h = await this.client!.request<{ uptimeMs: number; clients: number }>("health");
        await ctx.reply(`Gateway uptime: ${Math.round(h.uptimeMs / 1000)}s, clients: ${h.clients}`);
      } catch (err) {
        await ctx.reply(`Health check failed: ${(err as Error).message}`);
      }
    });

    // 消息处理
    this.bot.on("message:text", async (ctx) => {
      if (ctx.chat.type !== "private") {
        const mentioned = ctx.message.text.includes(`@${botInfo.username}`);
        const repliedToMe = ctx.message.reply_to_message?.from?.id === botInfo.id;
        if (!mentioned && !repliedToMe) return;
      }

      const chatId = ctx.chat.id;
      const sessionKey = this._sessionKeyFor(chatId);
      this.sessionChats.set(sessionKey, chatId);

      this._startTyping(chatId);

      try {
        await this.client!.request("chat.send", { sessionKey, message: ctx.message.text });
      } catch (err) {
        this._stopTyping(chatId);
        await ctx.reply(`Error: ${(err as Error).message}`);
      }
    });

    // 启动 bot
    this.bot.start();
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
        await this.client.request("notifications.register", { config: notifConfig });
        console.log(`\x1b[2m  notifications: ${this.notificationTargets.join(", ")}\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[33m  notification register failed: ${(err as Error).message}\x1b[0m`);
      }
    }

    console.log(`\n\x1b[36m\u25cf\x1b[0m \x1b[1mTelegram Channel\x1b[0m`);
    console.log(`\x1b[2m  gateway: ${gwUrl} (v${hello.protocol})\x1b[0m`);
    console.log(`\x1b[2m  bot: polling\x1b[0m`);
    console.log(`\x1b[2m  commands: /start /reset /health\x1b[0m`);
    console.log(`\x1b[2m  Ctrl+C to stop\x1b[0m\n`);
  }

  async stop(): Promise<void> {
    this._running = false;
    this._connected = false;
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.sessionChats.clear();
    this.bot?.stop();
    this.client?.close();
    this.bot = null;
    this.client = null;
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

  private _sessionKeyFor(chatId: number): string {
    return skf(CHANNEL_ID, String(chatId));
  }

  private _startTyping(chatId: number): void {
    this._stopTyping(chatId);
    this.bot!.api.sendChatAction(chatId, "typing").catch(() => { });
    this.typingTimers.set(chatId, setInterval(() => {
      this.bot!.api.sendChatAction(chatId, "typing").catch(() => { });
    }, TYPING_INTERVAL_MS));
  }

  private _stopTyping(chatId: number): void {
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
  }

  private async _sendLongMessage(chatId: number, text: string): Promise<void> {
    if (!text) return;
    let remaining = text;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, TG_MAX_LENGTH);
      remaining = remaining.slice(TG_MAX_LENGTH);
      await this.bot!.api.sendMessage(chatId, chunk);
    }
  }

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

    // 从 sessionKey 解析目标 chatId
    // 优先从 sessionChats 映射获取（用户主动发消息的场景）
    let chatId = this.sessionChats.get(p.sessionKey);

    // 如果 sessionChats 中没有记录（系统推送场景），
    // 直接从 sessionKey 解析 identifier 作为 chatId
    if (!chatId) {
      const identifier = p.sessionKey.slice(`${CHANNEL_ID}:`.length);
      const parsed = Number(identifier);
      if (!Number.isNaN(parsed)) {
        chatId = parsed;
        // 反向注册到 sessionChats 以便后续消息复用
        this.sessionChats.set(p.sessionKey, chatId);
      } else {
        return; // 无法解析目标，丢弃
      }
    }

    this._lastEventAt = Date.now();

    if (p.state === "final") {
      this._stopTyping(chatId);
      if (p.text) this._sendLongMessage(chatId, p.text).catch(console.error);
    } else if (p.state === "error") {
      this._stopTyping(chatId);
      this._lastError = p.error ?? "unknown";
      this.bot!.api.sendMessage(chatId, `Error: ${p.error ?? "unknown"}`).catch(console.error);
    }
  }
}

// ============== 工厂函数（向后兼容） ==============

export async function startTelegramChannel(opts: TelegramChannelOptions) {
  const ch = new TelegramChannel();
  await ch.start({
    botToken: opts.botToken,
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
  });
  return {
    close: () => ch.stop(),
    getStatus: () => ch.getStatus(),
  };
}
