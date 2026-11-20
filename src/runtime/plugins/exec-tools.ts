/**
 * exec-tools 插件：命令/文件工具一律用 hotwave 自有实现，禁用任何第三方命令工具。
 */

import type { LegacyTool } from './adapt-legacy.js';
import { createLegacyAdapter } from './adapt-legacy.js';

const TIMEOUTS: Record<string, number> = {
  exec: 120_000, read: 20_000, write: 20_000, edit: 20_000, list: 20_000, grep: 30_000,
};
const DEFAULT_TIMEOUT = 20_000;

export const HOTWAVE_EXEC_TOOLS = ['exec', 'read', 'write', 'edit', 'list', 'grep'] as const;

export function createExecPlugin(tools: LegacyTool[], out?: any[], workspaceDir: string = process.cwd()) {
  const adapt = createLegacyAdapter(() => ({ workspaceDir, sessionKey: 'sdk' }));

  return {
    name: 'exec-tools',
    inject: ['tools', 'approvalPolicy'],
    async apply(ctx: any) {
      const registry = ctx.get('tools');
      const picked = tools.filter((t) => (HOTWAVE_EXEC_TOOLS as readonly string[]).includes(t.name));
      for (const tool of picked) {
        const def = adapt(tool, { timeoutMs: TIMEOUTS[tool.name] ?? DEFAULT_TIMEOUT, workspaceDir });
        const original = def.execute;
        def.execute = async (args: any, exec: any) => {
          if (ctx.get('approvalPolicy').decide(tool.name) === 'ask') {
            return { text: '需要人工审批：' + tool.name, pendingApproval: true };
          }
          return original(args, exec);
        };
        registry.register(def);
        out?.push(def);
      }
      console.log('[exec-tools] apply done, registered=' + picked.length + ' (hotwave-owned: ' + picked.map((t) => t.name).join(',') + ')');
    },
  };
}
