/**
 * 运行时装配（组合根）
 *
 * 只负责按 inject 顺序把插件装进 Context，具体实现都在 ./plugins/*：
 *   services.ts     审批/行情/记忆/定时唤醒
 *   finance-tools.ts  9 个只读金融工具
 *   trade-tools.ts    10 个交易工具（含 dry-run 护栏与审批判定）
 *   exec-tools.ts     6 个 hotwave 自有命令/文件工具
 */

import { Context } from '../kernel/plugin.js';
import { ToolRegistry } from '../kernel/tools.js';
import { createServicePlugins } from './plugins/services.js';
import { createFinancePlugin } from './plugins/finance-tools.js';
import { createTradePlugin } from './plugins/trade-tools.js';
import { createExecPlugin } from './plugins/exec-tools.js';
import { createOcrPlugin } from './plugins/ocr.js';
import { createNotifierPlugin } from './plugins/channels.js';
import { createChannelRuntimePlugin } from './plugins/channels-runtime.js';
import { createDshCompatPlugin } from './plugins/dsh-compat.js';

import { fetchServerOne } from '../tools/server-app-data.js';
import { MemoryManager } from '../capabilities/memory.js';
import { financeTools } from '../tools/finance.js';
import { traderTools } from '../tools/trader.js';
import { builtinTools } from '../tools/builtin.js';

export type Runtime = {
  ctx: Context;
  registry: ToolRegistry;
  tools: string[];
};

export async function buildRuntime(opts: { workspaceDir: string }): Promise<Runtime> {
  const ctx = new Context();
  const registry = new ToolRegistry();
  ctx.provide('tools', registry);

  for (const p of createServicePlugins({ fetchServerOne, MemoryManager, workspaceDir: opts.workspaceDir })) {
    await ctx.plugin(p);
  }

  // 通知路由配置：所有权在此插件，RPC 层消费它
  await ctx.plugin(createNotifierPlugin());

  // IM 渠道（可选，默认关）
  await ctx.plugin(createChannelRuntimePlugin());

  // DSH 插件兼容层（可选，默认关）
  await ctx.plugin(createDshCompatPlugin());

  const financeOut: any[] = [];
  const tradeOut: any[] = [];
  const execOut: any[] = [];

  await ctx.plugin(createFinancePlugin(financeTools as any[], financeOut));
  await ctx.plugin(createTradePlugin(traderTools as any[], tradeOut));
  await ctx.plugin(createExecPlugin(builtinTools as any[], execOut, opts.workspaceDir));

  // OCR：进程内 ddddocr（按需 spawn src/trader/captcha/worker.py，无端口/无常驻服务）+ ocr_captcha 工具
  const ocrOut: any[] = [];
  await ctx.plugin(createOcrPlugin(ocrOut));

  return {
    ctx,
    registry,
    tools: registry.list().map((d) => d.name),
  };
}
