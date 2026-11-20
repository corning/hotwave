#!/usr/bin/env node
/**
 * 批量启动所有已配置的 Channel
 *
 * 读取环境变量，对每个 enabled 的 channel 检查配置是否完整，
 * 通过 Promise.all 并行启动。
 *
 * 用法:
 *   tsx src/channels/start-all.ts
 *   tsx src/channels/start-all.ts --gateway-url ws://localhost:18789 --gateway-token xxx
 */

import fs from "node:fs";
import path from "node:path";
import { hotwavePaths } from "../common/paths.js";
import { startTelegramChannel } from "./telegram.js";
import { startFeishuChannel } from "./feishu.js";
import { startDingtalkChannel } from "./dingtalk.js";
import { startWechatChannel } from "./wechat.js";

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

// ============== 参数 ==============

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const cliArgs = process.argv.slice(2);
const sharedOpts = {
  gatewayUrl: flag(cliArgs, "--gateway-url") ?? process.env.HOTWAVE_GW_URL ?? "ws://localhost:18789",
  gatewayToken: flag(cliArgs, "--gateway-token") ?? process.env.HOTWAVE_GW_TOKEN,
};

// ============== Channel 启动器 ==============

interface ChannelStarter {
  name: string;
  label: string;
  enabled: boolean;
  start: () => Promise<{ close: () => void }>;
}

const starters: ChannelStarter[] = [
  {
    name: "telegram",
    label: "Telegram",
    enabled: !!process.env.TELEGRAM_BOT_TOKEN,
    start: async () => {
      const botToken = process.env.TELEGRAM_BOT_TOKEN!;
      console.log(`\x1b[2m  [telegram] starting...\x1b[0m`);
      return startTelegramChannel({ botToken, ...sharedOpts });
    },
  },
  {
    name: "feishu",
    label: "飞书",
    enabled: !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET),
    start: async () => {
      console.log(`\x1b[2m  [feishu] starting...\x1b[0m`);
      return startFeishuChannel({
        appId: process.env.FEISHU_APP_ID!,
        appSecret: process.env.FEISHU_APP_SECRET!,
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
        encryptKey: process.env.FEISHU_ENCRYPT_KEY,
        ...sharedOpts,
      });
    },
  },
  {
    name: "dingtalk",
    label: "钉钉",
    enabled: !!(process.env.DINGTALK_CLIENT_ID && process.env.DINGTALK_CLIENT_SECRET),
    start: async () => {
      console.log(`\x1b[2m  [dingtalk] starting...\x1b[0m`);
      return startDingtalkChannel({
        clientId: process.env.DINGTALK_CLIENT_ID!,
        clientSecret: process.env.DINGTALK_CLIENT_SECRET!,
        ...sharedOpts,
      });
    },
  },
  {
    name: "wechat",
    label: "微信",
    enabled: !!process.env.WECHAT_BOT_TOKEN,
    start: async () => {
      console.log(`\x1b[2m  [wechat] starting...\x1b[0m`);
      return startWechatChannel({
        botToken: process.env.WECHAT_BOT_TOKEN!,
        baseUrl: process.env.WECHAT_BOT_BASE_URL,
        accountId: process.env.WECHAT_BOT_ACCOUNT_ID,
        ...sharedOpts,
      });
    },
  },
];

// ============== 可复用的启动函数 ==============

export interface ChannelHandle {
  name: string;
  close: () => void;
}

export async function startAllChannels(
  gatewayUrl?: string,
  gatewayToken?: string,
): Promise<ChannelHandle[]> {
  if (gatewayUrl) sharedOpts.gatewayUrl = gatewayUrl;
  if (gatewayToken) sharedOpts.gatewayToken = gatewayToken;

  const enabled = starters.filter((s) => s.enabled);

  if (enabled.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(enabled.map((s) => s.start()));

  const handles: ChannelHandle[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      handles.push({ name: enabled[i].label, close: r.value.close });
    } else {
      console.error(`\x1b[31m  [${enabled[i].label}] failed: ${r.reason?.message ?? r.reason}\x1b[0m`);
    }
  }

  return handles;
}

// ============== CLI 入口 ==============

async function main() {
  const handles = await startAllChannels();

  if (handles.length === 0) {
    console.log("No channels configured. Set environment variables to enable channels.");
    console.log("  Telegram:  TELEGRAM_BOT_TOKEN");
    console.log("  飞书:      FEISHU_APP_ID + FEISHU_APP_SECRET");
    console.log("  钉钉:      DINGTALK_CLIENT_ID + DINGTALK_CLIENT_SECRET");
    console.log("  微信:      WECHAT_BOT_TOKEN");
    process.exit(0);
  }

  console.log(`\n\x1b[32m\u2713\x1b[0m ${handles.length} channel(s) running. Ctrl+C to stop.\n`);

  process.on("SIGINT", () => {
    console.log("\nShutting down channels...");
    for (const h of handles) {
      try { h.close(); } catch { }
    }
    console.log("Bye!");
    process.exit(0);
  });
}

if (process.argv[1]?.endsWith("start-all.ts") || process.argv[1]?.endsWith("start-all.js")) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
