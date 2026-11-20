/**
 * B4：渠道插件（声明式，默认不启动）
 *
 * 4 个 IM 渠道各自成为一个插件，Config 里放凭据；enabled=false 时不建立任何连接，
 * 因此在 spike / 本地开发中加载整棵树不会产生外部副作用。
 *
 * 真实启动复用 hotwave/src/channels/*（B4 阶段接入），此处只定义装配位与配置契约。
 */

export function createChannelPlugins() {
  const defs = [
    { id: 'channel-telegram', envToken: 'TELEGRAM_BOT_TOKEN' },
    { id: 'channel-feishu', envToken: 'FEISHU_APP_ID' },
    { id: 'channel-dingtalk', envToken: 'DINGTALK_CLIENT_ID' },
    { id: 'channel-wechat', envToken: 'WECHAT_BOT_TOKEN' },
  ];

  return defs.map((d) => ({
    name: d.id,
    inject: ['notifier'],
    async apply(ctx: any, config: any = {}) {
      const enabled = config.enabled === true && Boolean(process.env[d.envToken]);
      if (!enabled) {
        ctx.logger?.info?.('[%s] disabled (config.enabled=%s, env=%s)', d.id, config.enabled, d.envToken);
        return;
      }
      // B4 待接入：动态 import 对应 channel 模块并启动
      ctx.logger?.warn?.('[%s] 启动逻辑待 B4 接入', d.id);
    },
  }));
}

/** 通知路由插件：把 agent 输出按渠道分发（B4 骨架，保留现有 notification-router 的配置模型） */
export function createNotifierPlugin() {
  return {
    name: 'notifier',
    inject: [],
    async apply(ctx: any) {
      // 配置不再落盘：渠道进程启动时用 notifications.register 自注册；
      // 网关重启后由渠道重新注册即可（单机单人场景无需持久化）。
      ctx.provide('notifyRoutes', []);
      console.log('[notifier] 就绪（路由由渠道自注册，无配置文件）');
    },
  };
}

/** hotwave_server 桥接插件：反向长连接（B4 骨架，默认不连，避免与运行中的实例冲突） */
export function createServerBridgePlugin() {
  return {
    name: 'server-bridge',
    inject: [],
    async apply(ctx: any, config: any = {}) {
      const enabled = config.enabled === true;
      ctx.logger?.info?.('[server-bridge] %s', enabled ? '待接入（复用 hotwave-server-client）' : 'disabled');
    },
  };
}
