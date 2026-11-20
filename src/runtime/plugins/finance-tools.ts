/**
 * finance-tools 插件（自研 kernel + 自研 defineTool）
 *
 * 只读金融工具默认 allow-always：不产生审批、不阻塞（量化拼速度）。
 */

import type { LegacyTool } from './adapt-legacy.js';
import { createLegacyAdapter } from './adapt-legacy.js';

export const FINANCE_TOOLS_AUTO_APPROVED = true;

const TIMEOUTS: Record<string, number> = { finance_kline: 20_000, market_analysis: 20_000 };
const DEFAULT_TIMEOUT = 15_000;

export function createFinancePlugin(tools: LegacyTool[], out?: any[]) {
  const adapt = createLegacyAdapter();

  return {
    name: 'finance-tools',
    inject: ['tools'],
    async apply(ctx: any) {
      const registry = ctx.get('tools');
      for (const tool of tools) {
        const def = adapt(tool, { timeoutMs: TIMEOUTS[tool.name] ?? DEFAULT_TIMEOUT });
        registry.register(def);
        out?.push(def);
      }
      console.log('[finance-tools] apply done, registered=' + tools.length);
    },
  };
}
