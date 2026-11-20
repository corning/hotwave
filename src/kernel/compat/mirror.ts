/**
 * 把 DSH 工具镜像进 hotwave 的工具注册表
 *
 * 说明：DSH 的 ToolDefinition 与我们的字段高度一致（name/description/parameters/output/execute），
 * 但 execute 的第二个参数（exec context）语义不同：DSH 期望携带 agent/session 作用域。
 * 这里传入最小上下文（signal + sessionKey），并把它标注为"compat"来源，便于排障时区分。
 *
 * 对需要 agent 作用域的工具（如 todo_write），执行会抛错——这是被移植工具自身的限制，
 * 不是镜像层的问题；注册阶段仍然可用（模型能看到 schema）。
 */

import type { ToolRegistry } from '../tools.js';

export type MirrorResult = {
  registered: string[];
  skipped: string[];
};

export function mirrorDshTools(registry: ToolRegistry, defs: any[], opts?: { prefix?: string }): MirrorResult {
  const registered: string[] = [];
  const skipped: string[] = [];
  const prefix = opts?.prefix ?? '';

  for (const def of defs) {
    if (!def?.name) { skipped.push('(无名工具)'); continue; }
    const name = prefix + def.name;

    // 已存在同名工具时不覆盖（优先 hotwave 自有实现）
    if (registry.get(name)) { skipped.push(name); continue; }

    try {
      registry.register({
        name,
        description: String(def.description ?? ''),
        parameters: def.parameters ?? { type: 'object', properties: {} },
        output: {
          schema: def.output?.schema ?? { type: 'object', additionalProperties: true },
          // 直接复用 DSH 的 render（ContentBlock 形状兼容）
          render: (args: unknown, value: unknown) =>
            typeof def.output?.render === 'function'
              ? def.output.render(args, value)
              : [{ type: 'text' as const, text: JSON.stringify(value) }],
        },
        ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
        async execute(args: any, exec: any) {
          return def.execute(args, {
            signal: exec?.signal,
            sessionKey: exec?.sessionKey ?? 'main',
          });
        },
      });
      registered.push(name);
    } catch (e) {
      skipped.push(name + '(' + (e as Error).message + ')');
    }
  }

  return { registered, skipped };
}
