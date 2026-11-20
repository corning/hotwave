/**
 * DSH 兼容宿主（cordis shim）
 *
 * 目标：让 DSH 生态里"只依赖 tools / systemPrompt / sessionProjections 等少量服务"的插件
 * 能被 hotwave 原样加载，工具自动进入 hotwave 工具注册表。
 *
 * 实现方式：**内嵌真正的 cordis + DSH ToolsService**（而不是自己仿造），原因：
 *  - DSH 插件包自己 import @deepseek-ai/dsh-tools，defineTool/ToolsService 都来自那边；
 *    宿主侧只要提供 cordis 语义 + 它 inject 的服务，插件就能跑。
 *  - cordis 自带 Config（schemastery）校验、inject 门控、生命周期，省去仿造。
 *
 * 代价：这些包会成为 hotwave 的可选依赖；缺失时本模块不加载，hotwave 主链路不受影响。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';

/** DSH 需要的 systemPrompt 服务（ToolsService 的静态依赖） */
class StubSystemPrompt extends Service {
  constructor(ctx: any) {
    super(ctx, 'systemPrompt');
  }
  /** ToolsService 构造时会注册工具集提供者 */
  tools(_cb?: any) { return () => undefined; }
  section(_x?: any) { return []; }
}

/** sessionProjections 桩：DSH 的投影注册，hotwave 不做投影，接受并忽略 */
class StubSessionProjections extends Service {
  constructor(ctx: any) {
    super(ctx, 'sessionProjections');
  }
  async register(_unit: any) { return () => undefined; }
}

export type DshHost = {
  ctx: any;
  /** 已注册工具的模型可见 schema */
  schemas(): Array<{ name: string; description: string; parameters: any }>;
  /** 原始 ToolDefinition 列表（含 execute/render） */
  definitions(): any[];
  /** 已成功挂载的插件名 */
  loaded: string[];
  /** 挂载失败的插件（含原因，便于排障） */
  failed: Array<{ pkg: string; reason: string }>;
  dispose(): Promise<void>;
};

export type DshPluginSpec = { package: string; config?: any };

export async function createDshHost(plugins: DshPluginSpec[] = []): Promise<DshHost> {
  const ctx: any = new Context();
  await ctx.plugin(StubSystemPrompt);
  await ctx.plugin(StubSessionProjections);
  await ctx.plugin(ToolsService);

  const loaded: string[] = [];
  const failed: Array<{ pkg: string; reason: string }> = [];

  for (const spec of plugins) {
    try {
      const mod: any = await import(spec.package);
      const plugin = mod.default ?? mod;
      await ctx.plugin(plugin, spec.config ?? {});
      loaded.push(spec.package);
    } catch (e) {
      failed.push({ pkg: spec.package, reason: (e as Error).message });
    }
  }

  const definitions = () => (ctx.tools.definitions?.() ?? []) as any[];
  const schemas = () =>
    (ctx.tools.schemas?.() ?? []).map((s: any) => ({
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    }));

  return {
    ctx,
    schemas,
    definitions,
    loaded,
    failed,
    async dispose() {
      try { await ctx.fiber?.dispose?.(); } catch { /* ignore */ }
    },
  };
}
