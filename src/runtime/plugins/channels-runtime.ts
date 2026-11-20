/**
 * 渠道插件：在运行时进程内启动 IM 渠道（可选）
 *
 * 为什么可选：渠道需要外网凭据，开源部署者未必配置；默认关闭，
 * 只有显式 CHANNELS_ENABLED=true 才启动。也可继续用 pnpm channel:start 独立进程方式。
 *
 * 环境变量：
 *   CHANNELS_ENABLED=true      启用内启动
 *   CHANNELS=feishu,dingtalk   指定要启动的渠道；留空=自动启用所有已配置凭据的渠道
 *   HOTWAVE_GW_URL / HOTWAVE_GW_TOKEN  渠道连接网关用（默认 ws://localhost:18789）
 */

export type ChannelHandleLike = { name: string; close: () => void };

export function createChannelRuntimePlugin(out?: ChannelHandleLike[]) {
  return {
    name: 'channels-runtime',
    inject: [],
    async apply(ctx: any) {
      if (process.env.CHANNELS_ENABLED !== 'true') {
        console.log('[channels-runtime] 未启用（CHANNELS_ENABLED!=true），如需在运行时内启动请设置');
        return;
      }

      const gwUrl = process.env.HOTWAVE_GW_URL || 'ws://localhost:18789';
      const gwToken = process.env.HOTWAVE_GW_TOKEN;
      const wanted = (process.env.CHANNELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const pick = (name: string) => wanted.length === 0 || wanted.includes(name);

      const started: ChannelHandleLike[] = [];
      const fail: string[] = [];

      const startOne = async (name: string, fn: () => Promise<ChannelHandleLike>) => {
        try {
          const h = await fn();
          started.push(h);
          console.log('[channels-runtime] 已启动: ' + name);
        } catch (e) {
          fail.push(name + '(' + (e as Error).message + ')');
          console.warn('[channels-runtime] 启动失败: ' + name + ' — ' + (e as Error).message);
        }
      };

      if (pick('telegram') && process.env.TELEGRAM_BOT_TOKEN) {
        const mod = await import('../../channels/telegram.js');
        await startOne('telegram', async () =>
          (await mod.startTelegramChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN!, gatewayUrl: gwUrl, gatewayToken: gwToken })) as any,
        );
      }
      if (pick('feishu') && process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
        const mod = await import('../../channels/feishu.js');
        await startOne('feishu', async () =>
          (await mod.startFeishuChannel({
            appId: process.env.FEISHU_APP_ID!,
            appSecret: process.env.FEISHU_APP_SECRET!,
            verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
            encryptKey: process.env.FEISHU_ENCRYPT_KEY,
            gatewayUrl: gwUrl,
            gatewayToken: gwToken,
          })) as any,
        );
      }
      if (pick('dingtalk') && process.env.DINGTALK_CLIENT_ID && process.env.DINGTALK_CLIENT_SECRET) {
        const mod = await import('../../channels/dingtalk.js');
        await startOne('dingtalk', async () =>
          (await mod.startDingtalkChannel({
            clientId: process.env.DINGTALK_CLIENT_ID!,
            clientSecret: process.env.DINGTALK_CLIENT_SECRET!,
            gatewayUrl: gwUrl,
            gatewayToken: gwToken,
          })) as any,
        );
      }
      if (pick('wechat') && process.env.WECHAT_BOT_TOKEN) {
        const mod = await import('../../channels/wechat.js');
        await startOne('wechat', async () =>
          (await mod.startWechatChannel({
            botToken: process.env.WECHAT_BOT_TOKEN!,
            baseUrl: process.env.WECHAT_BOT_BASE_URL,
            accountId: process.env.WECHAT_BOT_ACCOUNT_ID,
            gatewayUrl: gwUrl,
            gatewayToken: gwToken,
          })) as any,
        );
      }

      if (started.length === 0 && fail.length === 0) {
        console.log('[channels-runtime] 无可用渠道（未配置凭据或未在 CHANNELS 中）');
      }
      out?.push(...started);

      ctx.effect(() => {
        for (const h of started) {
          try { h.close(); } catch { /* ignore */ }
        }
      });
    },
  };
}
