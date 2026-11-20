/**
 * trade-tools 插件（自研 kernel）
 *
 * 双层保护：
 *  1. dry-run 护栏：TRADE_DRY_RUN=true 时写类工具只预演、不触达 TradeRouter（默认 false=直接执行）
 *  2. 审批策略：ApprovalPolicy 决定（默认 always-auto 含实盘；guarded 需人工）
 */

import type { LegacyTool } from './adapt-legacy.js';
import { createLegacyAdapter } from './adapt-legacy.js';

const TIMEOUTS: Record<string, number> = {
  trader_buy: 30_000, trader_sell: 30_000, trader_cancel: 20_000, trader_login: 60_000,
};
const DEFAULT_TIMEOUT = 15_000;
const WRITE_TOOLS = new Set(['trader_buy', 'trader_sell', 'trader_cancel', 'trader_login']);

/**
 * 下单串行锁（关键安全边界）
 *
 * 心跳与对话是两条**并行** lane（心跳不再因为用户聊天而让路）。两者都可能调到
 * trader_buy / trader_sell / trader_cancel，若并发执行会出现"同一信号下两次委托"
 * 或"撤单与下单交错"。写类工具统一在本锁内串行执行；读类工具不受影响。
 */
let tradeChain: Promise<unknown> = Promise.resolve();

function runLocked<T>(fn: () => Promise<T>): Promise<T> {
  const prev = tradeChain.catch(() => undefined);
  let release!: () => void;
  tradeChain = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(() => fn()).finally(() => release()) as Promise<T>;
}

export function createTradePlugin(tools: LegacyTool[], out?: any[]) {
  const adapt = createLegacyAdapter();
  const dryRun = process.env.TRADE_DRY_RUN === 'true'; // 生产默认 false：直接执行；测试置 true 保护账户

  return {
    name: 'trade-tools',
    inject: ['tools', 'approvalPolicy'],
    async apply(ctx: any) {
      const registry = ctx.get('tools');
      for (const tool of tools) {
        const def = adapt(tool, { timeoutMs: TIMEOUTS[tool.name] ?? DEFAULT_TIMEOUT });
        const original = def.execute;
        def.execute = async (args: any, exec: any) => {
          if (WRITE_TOOLS.has(tool.name) && dryRun) {
            return { text: '[dry-run] ' + tool.name + ' 未真实执行（TRADE_DRY_RUN=true）。参数：' + JSON.stringify(args), dryRun: true };
          }
          if (ctx.get('approvalPolicy').decide(tool.name) === 'ask') {
            return { text: '需要人工审批：' + tool.name, pendingApproval: true };
          }
          if (WRITE_TOOLS.has(tool.name)) {
            const t0 = Date.now();
            return runLocked(async () => {
              const waited = Date.now() - t0;
              if (waited > 30) console.log('[trade-lock] ' + tool.name + ' 等待 ' + waited + 'ms（另一 lane 正在下单）');
              return original(args, exec);
            });
          }
          return original(args, exec);
        };
        registry.register(def);
        out?.push(def);
      }
      console.log('[trade-tools] apply done, registered=' + tools.length + ', writeMode=' + (dryRun ? 'dry-run' : 'REAL'));
    },
  };
}
