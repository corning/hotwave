/**
 * DSH 兼容插件（默认常驻启用）
 *
 * 启动时总会初始化 cordis 宿主；插件清单：DSH_PLUGINS="pkg1,pkg2"（逗号分隔），或 config/dsh-plugins.json：
 *   [{"package":"@deepseek-ai/dsh-tool-xxx","config":{...}}]
 *   （先在该目录 pnpm add 你要用的插件包）
 *
 * 工具名默认加前缀 "dsh_" 以免与 hotwave 自有工具冲突（可用 DSH_TOOL_PREFIX 覆盖，置空则不加）。
 */
// 动态导入：兼容层常驻启用，但 DSH 包缺失时降级为告警，不阻塞主链路
type DshPluginSpec = { package: string; config?: any };

async function loadSpecs(): Promise<DshPluginSpec[]> {
  const fromEnv = (process.env.DSH_PLUGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length > 0) return fromEnv.map((pkg) => ({ package: pkg }));

  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    const { hotwavePaths } = await import('../../common/paths.js');
    const candidates = [
      process.env.DSH_PLUGIN_CONFIG,
      path.join(hotwavePaths().config, 'dsh-plugins.json'),
      path.join(process.cwd(), 'config', 'dsh-plugins.json'),
    ].filter(Boolean) as string[];
    const file = candidates.find((f) => existsSync(f));
    if (!file) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: any) => x && typeof x.package === 'string')
      .map((x: any) => ({ package: x.package, config: x.config ?? {} }));
  } catch {
    return [];
  }
}

export function createDshCompatPlugin() {
  return {
    name: 'dsh-compat',
    inject: ['tools'],
    async apply(ctx: any) {
      const specs = await loadSpecs();
      if (specs.length === 0) {
        console.log('[dsh-compat] 宿主已就绪（未配置插件；可用 DSH_PLUGINS 或 config/dsh-plugins.json 指定）');
        return;
      }

      let host: any;
      let createDshHost: any;
      let mirrorDshTools: any;
      try {
        ({ createDshHost } = await import('../../kernel/compat/dsh-host.js'));
        ({ mirrorDshTools } = await import('../../kernel/compat/mirror.js'));
        host = await createDshHost(specs);
      } catch (e) {
        console.warn('[dsh-compat] 宿主初始化失败（可能缺少 @deepseek-ai/* 依赖）:', (e as Error).message);
        return;
      }

      console.log(
        '[dsh-compat] 挂载 ' + host.loaded.length + '/' + specs.length + ' 个 DSH 插件' +
          (host.failed.length ? '，失败: ' + host.failed.map((f: any) => f.pkg + '(' + f.reason + ')').join('; ') : ''),
      );

      const prefix = process.env.DSH_TOOL_PREFIX ?? 'dsh_';
      const result = mirrorDshTools(ctx.get('tools'), host.definitions(), { prefix });
      console.log(
        '[dsh-compat] 镜像工具 ' + result.registered.length + ' 个: ' + result.registered.join(',') +
          (result.skipped.length ? ' | 跳过: ' + result.skipped.join(',') : ''),
      );

      ctx.effect(() => { void host!.dispose(); });
    },
  };
}
