/**
 * hotwave 旧工具 -> 自研 ToolDefinition 适配器
 *
 * 旧工具形状： { name, description, inputSchema(JSON Schema 对象根), execute(input, ctx) => string }
 * 新契约：     defineTool({ name, description, parameters(属性表 DSL), output:{schema, render}, execute })
 *
 * 转换点：
 *   1. inputSchema.properties/required → 属性表 DSL（每属性 required:true）
 *   2. 旧工具返回 string → 包成 { text }，render 投影为 text 块
 *   3. hotwave 文件/命令工具依赖 ctx.workspaceDir，需注入执行上下文
 */

import { defineTool } from '../../kernel/tools.js';

export type LegacyTool = {
  name: string;
  description: string;
  inputSchema: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  execute(input: any, ctx?: any): Promise<string>;
};

export type LegacyToolContext = {
  workspaceDir: string;
  sessionKey: string;
  abortSignal?: AbortSignal;
};

function toProp(node: any, required: boolean): any {
  const base: any = {};
  if (node?.description) base.description = node.description;
  if (node?.enum) base.enum = node.enum;
  switch (node?.type) {
    case 'string': base.type = 'string'; break;
    case 'integer': base.type = 'integer'; break;
    case 'number': base.type = 'number'; break;
    case 'boolean': base.type = 'boolean'; break;
    case 'array':
      base.type = 'array';
      if (node.items) base.items = toProp(node.items, false);
      break;
    case 'object': {
      base.type = 'object';
      base.additionalProperties = node.additionalProperties === true;
      const props: any = {};
      const req: string[] = node.required ?? [];
      for (const [k, v] of Object.entries(node.properties ?? {})) props[k] = toProp(v, req.includes(k));
      base.properties = props;
      break;
    }
    default: base.type = 'json';
  }
  if (required) base.required = true;
  return base;
}

/** 顶层 inputSchema → 属性表 DSL */
function toParameters(inputSchema: LegacyTool['inputSchema']): Record<string, any> {
  const props = inputSchema?.properties ?? {};
  const required = inputSchema?.required ?? [];
  const spec: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) spec[key] = toProp(value, required.includes(key));
  return spec;
}

export function createLegacyAdapter(contextProvider?: () => LegacyToolContext) {
  return function adapt(tool: LegacyTool, opts?: { timeoutMs?: number; workspaceDir?: string }) {
    return defineTool({
      name: tool.name,
      description: tool.description,
      parameters: toParameters(tool.inputSchema),
      output: {
        schema: { text: { type: 'string', required: true } },
        render: (_args: unknown, value: any) => [{ type: 'text' as const, text: String(value?.text ?? '') }],
      },
      ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      async execute(args: any, exec: any) {
        const base = contextProvider?.();
        const ctx = base
          ? { ...base, workspaceDir: opts?.workspaceDir ?? base.workspaceDir, abortSignal: exec?.signal }
          : { workspaceDir: opts?.workspaceDir ?? process.cwd(), sessionKey: 'sdk', abortSignal: exec?.signal };
        const text = await tool.execute(args, ctx as any);
        return { text };
      },
    });
  };
}
