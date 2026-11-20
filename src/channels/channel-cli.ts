#!/usr/bin/env node
/**
 * Channel CLI 入口
 *
 * 用法:
 *   tsx src/channels/channel-cli.ts telegram [--bot-token X] [--gateway-url ws://...] [--gateway-token xxx]
 *   tsx src/channels/channel-cli.ts feishu [--app-id X] [--app-secret X] [--gateway-url ...]
 *   tsx src/channels/channel-cli.ts dingtalk [--client-id X] [--client-secret X] [--gateway-url ...]
 *   tsx src/channels/channel-cli.ts wechat [--bot-token X] [--base-url X] [--gateway-url ...]
 */

import fs from "node:fs";
import path from "node:path";
import { hotwavePaths } from "../common/paths.js";
import { startTelegramChannel } from "./telegram.js";
import { startFeishuChannel } from "./feishu.js";
import { startDingtalkChannel } from "./dingtalk.js";
import { startWechatChannel } from "./wechat.js";
import { CHANNEL_REGISTRY } from "./index.js";

// ============== .env ==============

function loadEnvFile(): void {
  const homeEnv = hotwavePaths().envFile;
  const envPath = fs.existsSync(homeEnv) ? homeEnv : path.join(process.cwd(), ".env");
  let content: string;
  try { content = fs.readFileSync(envPath, "utf-8"); } catch { return; }
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

// ============== 参数解析 ==============

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const channelName = args[0] ?? "telegram";

function gatewayOpts(args: string[]) {
  return {
    gatewayUrl: flag(args, "--gateway-url") ?? process.env.HOTWAVE_GW_URL ?? "ws://localhost:18789",
    gatewayToken: flag(args, "--gateway-token") ?? process.env.HOTWAVE_GW_TOKEN,
  };
}

// ============== telegram ==============

async function telegram() {
  const botToken = flag(args, "--bot-token") ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("Error: Telegram bot token not found.");
    console.error("Set TELEGRAM_BOT_TOKEN in .env or pass --bot-token <token>");
    process.exit(1);
  }
  const ch = await startTelegramChannel({ botToken, ...gatewayOpts(args) });
  process.on("SIGINT", () => { ch.close(); console.log("\nBye!"); process.exit(0); });
}

// ============== feishu ==============

async function feishu() {
  const appId = flag(args, "--app-id") ?? process.env.FEISHU_APP_ID;
  const appSecret = flag(args, "--app-secret") ?? process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.error("Error: Feishu appId and appSecret are required.");
    console.error("Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env or pass --app-id / --app-secret");
    process.exit(1);
  }
  const ch = await startFeishuChannel({
    appId,
    appSecret,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    ...gatewayOpts(args),
  });
  process.on("SIGINT", () => { ch.close(); console.log("\nBye!"); process.exit(0); });
}

// ============== dingtalk ==============

async function dingtalk() {
  const clientId = flag(args, "--client-id") ?? process.env.DINGTALK_CLIENT_ID;
  const clientSecret = flag(args, "--client-secret") ?? process.env.DINGTALK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Error: Dingtalk clientId and clientSecret are required.");
    console.error("Set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET in .env or pass --client-id / --client-secret");
    process.exit(1);
  }
  const ch = await startDingtalkChannel({ clientId, clientSecret, ...gatewayOpts(args) });
  process.on("SIGINT", () => { ch.close(); console.log("\nBye!"); process.exit(0); });
}

// ============== wechat ==============

async function wechat() {
  const botToken = flag(args, "--bot-token") ?? process.env.WECHAT_BOT_TOKEN;
  const baseUrl = flag(args, "--base-url") ?? process.env.WECHAT_BOT_BASE_URL;
  if (!botToken) {
    console.error("Error: Wechat bot token not found.");
    console.error("Set WECHAT_BOT_TOKEN in .env or pass --bot-token <token>");
    process.exit(1);
  }
  const ch = await startWechatChannel({
    botToken,
    baseUrl,
    accountId: process.env.WECHAT_BOT_ACCOUNT_ID,
    ...gatewayOpts(args),
  });
  process.on("SIGINT", () => { ch.close(); console.log("\nBye!"); process.exit(0); });
}

// ============== 入口 ==============

const channels: Record<string, () => void> = {
  telegram,
  feishu,
  dingtalk,
  wechat,
};

if (channels[channelName]) {
  channels[channelName]();
} else {
  console.error(`Unknown channel: ${channelName}`);
  const available = Object.keys(CHANNEL_REGISTRY).join(", ");
  console.error(`Available channels: ${available}`);
  process.exit(1);
}
