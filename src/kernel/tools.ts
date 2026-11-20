/**
 * 自研工具契约 + 注册表（替代 @deepseek-ai/dsh-tools）
 *
 * 与 DSH 的 ToolDefinition 语义对齐，但完全自持：
 *  - defineTool：参数校验、输出 schema、render 投影
 *  - ToolRegistry：注册/查找/引用计数、串行/并行执行、超时与取消
 *  - 错误类型：ToolArgsError / ToolNotFoundError / ToolTimeoutError
 *
 * 零外部依赖，只用 hotwave 自己的 kernel/schema。
 */

import { parametersToJsonSchema, validateValue, type JsonSchema, type ParameterSpec } from './schema.js';

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; mimeType: string; data: string };
export type ContentBlock = TextBlock | ImageBlock;

export class ToolError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ToolError';
  }
}
export class ToolArgsError extends ToolError {
  constructor(public violations: string[]) {
    super('invalid arguments: ' + violations.join('; '), 'INVALID_ARGS');
    this.name = 'ToolArgsError';
  }
}
export class ToolNotFoundError extends ToolError {
  constructor(name: string) {
    super('tool not found: ' + name, 'NOT_FOUND');
    this.name = 'ToolNotFoundError';
  }
}
export class ToolTimeoutError extends ToolError {
  constructor(name: string, ms: number) {
    super('tool timeout: ' + name + ' after ' + ms + 'ms', 'TIMEOUT');
    this.name = 'ToolTimeoutError';
  }
}

export type ToolRunContext = {
  signal?: AbortSignal;
  sessionKey?: string;
  [k: string]: unknown;
};

export type ToolDefinition = {
  name: string;
  description: string;
  /** 模型可见的 JSON Schema（由 parameters 规格编译而来） */
  parameters: JsonSchema;
  output: {
    schema: JsonSchema;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  timeoutMs?: number;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
};

export type DefineToolOptions = {
  name: string;
  description: string;
  parameters?: ParameterSpec;
  output?: {
    schema?: ParameterSpec;
    render?: (args: unknown, value: unknown) => ContentBlock[];
  };
  timeoutMs?: number;
  execute(args: any, exec: ToolRunContext): Promise<unknown>;
};

const DEFAULT_RENDER = (_args: unknown, value: unknown): ContentBlock[] => {
  if (value && typeof value === 'object' && 'text' in (value as any)) {
    return [{ type: 'text', text: String((value as any).text) }];
  }
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
};

export function defineTool(options: DefineToolOptions): ToolDefinition {
  const parameters = parametersToJsonSchema(options.parameters ?? {});
  const outputSchema = options.output?.schema ? parametersToJsonSchema(options.output.schema) : null;
  const render = options.output?.render ?? DEFAULT_RENDER;

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema ?? { type: 'object', additionalProperties: true },
      render(args, value) {
        return render(args, value);
      },
    },
    ...(options.timeoutMs && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validateValue(parameters, args, '');
      if (violations.length > 0) throw new ToolArgsError(violations);
      return options.execute(args, exec ?? {});
    },
  };
}

/** 工具注册表（一个 ctx 一份，通过 ctx.provide('tools', registry) 暴露） */
export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();
  private disposers = new Map<string, () => void>();

  register(def: ToolDefinition): () => void {
    if (this.defs.has(def.name)) {
      throw new ToolError('duplicate tool: ' + def.name, 'DUPLICATE');
    }
    this.defs.set(def.name, def);
    const dispose = () => {
      this.defs.delete(def.name);
      this.disposers.delete(def.name);
    };
    this.disposers.set(def.name, dispose);
    return dispose;
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.defs.values()];
  }

  /** 模型可见的工具清单（name/description/parameters） */
  schemas(): Array<{ name: string; description: string; parameters: JsonSchema }> {
    return this.list().map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
  }

  /**
   * 执行一个工具：校验 → 超时/取消 → 输出 schema 校验
   * @param opts.timeoutMs 覆盖工具自带超时
   */
  async execute(name: string, args: unknown, exec: ToolRunContext = {}, opts: { timeoutMs?: number } = {}): Promise<{ value: unknown; content: ContentBlock[] }> {
    const def = this.defs.get(name);
    if (!def) throw new ToolNotFoundError(name);

    const timeoutMs = opts.timeoutMs ?? def.timeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 超时必须真正生效：与工具实现竞速，不能只依赖 AbortSignal（实现未必响应）
    const execPromise = def.execute(args, { ...exec, signal: controller.signal });
    const timeoutPromise = timeoutMs && timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ToolTimeoutError(name, timeoutMs)), timeoutMs);
        })
      : null;

    try {
      const value = timeoutPromise
        ? await Promise.race([execPromise, timeoutPromise])
        : await execPromise;
      if (timer) clearTimeout(timer);
      const violations = validateValue(def.output.schema, value, '');
      if (violations.length > 0) {
        throw new ToolError('output 不符合 schema: ' + violations.join('; '), 'INVALID_OUTPUT');
      }
      return { value, content: def.output.render(args, value) };
    } catch (err) {
      if (timer) clearTimeout(timer);
      if ((err as Error)?.name === 'AbortError' && timeoutMs) throw new ToolTimeoutError(name, timeoutMs);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 批量并行执行（默认并发 10） */
  async executeBatch(
    calls: Array<{ name: string; args?: unknown }>,
    exec: ToolRunContext = {},
    concurrency = 10,
  ): Promise<Array<{ name: string; ok: boolean; value?: unknown; content?: ContentBlock[]; error?: string }>> {
    const results: Array<{ name: string; ok: boolean; value?: unknown; content?: ContentBlock[]; error?: string }> = [];
    let index = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, calls.length)) }, async () => {
      while (index < calls.length) {
        const i = index++;
        const call = calls[i];
        try {
          const r = await this.execute(call.name, call.args ?? {}, exec);
          results[i] = { name: call.name, ok: true, value: r.value, content: r.content };
        } catch (e) {
          results[i] = { name: call.name, ok: false, error: (e as Error).message };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }
}
