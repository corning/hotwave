/**
 * Channel 模块导出
 */

export { startTelegramChannel, TelegramChannel, type TelegramChannelOptions } from "./telegram.js";
export { startFeishuChannel, FeishuChannel, type FeishuChannelOptions } from "./feishu.js";
export { startDingtalkChannel, DingtalkChannel, type DingtalkChannelOptions } from "./dingtalk.js";
export { startWechatChannel, WechatChannel, type WechatChannelOptions } from "./wechat.js";
export { type Channel, type ChannelConfig, type ChannelStatus, sessionKeyFor } from "./types.js";

// ============== Channel 注册表 ==============

export const CHANNEL_REGISTRY: Record<string, { id: string; label: string; enabled: boolean }> = {
  telegram: { id: "telegram", label: "Telegram", enabled: true },
  feishu: { id: "feishu", label: "飞书", enabled: false },
  dingtalk: { id: "dingtalk", label: "钉钉", enabled: false },
  wechat: { id: "wechat", label: "微信", enabled: false },
  hotwave: { id: "hotwave", label: "热浪金融", enabled: true },
};
