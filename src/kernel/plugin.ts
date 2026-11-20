/**
 * 极简插件内核（替代 cordis）
 *
 * 只实现我们真正需要的四点：
 *  1. 插件加载：`ctx.plugin(p, config)`，支持 `inject` 依赖门控
 *  2. 服务注册：`ctx.provide(name, value)` / `ctx.get(name)`，依赖就绪时自动放行等待中的插件
 *  3. 生命周期：`ctx.effect(cleanup)`，dispose 时按 LIFO 逆序执行
 *  4. 事件：`ctx.on/emit`（同步派发，异常隔离）
 *
 * 设计取舍：不做 HMR / 作用域 fork / 配置热更新——hotwave 用不到，
 * 且这些正是 cordis 复杂度的主要来源。
 */

export type PluginObject = {
  name?: string;
  /** 依赖的服务名；未就绪时插件排队等待 */
  inject?: string[];
  apply(ctx: Context, config?: any): void | Promise<void>;
};

export type Plugin = PluginObject | ((ctx: Context, config?: any) => void | Promise<void>);

type Pending = { deps: string[]; run: () => Promise<void>; name?: string };

export class Context {
  private services = new Map<string, unknown>();
  private effects: Array<() => void> = [];
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private pending: Pending[] = [];
  private disposed = false;

  /** 取服务（未注册返回 undefined） */
  get<T = any>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  /** 注册服务；触发等待队列 */
  provide<T>(name: string, value: T): T {
    if (this.services.has(name)) {
      throw new Error('duplicate service: ' + name);
    }
    this.services.set(name, value);
    void this.flush();
    return value;
  }

  /** 注册清理函数（dispose 时 LIFO 执行） */
  effect(fn: () => void): () => void {
    this.effects.push(fn);
    return () => {
      const i = this.effects.indexOf(fn);
      if (i >= 0) this.effects.splice(i, 1);
    };
  }

  on(event: string, cb: (...args: any[]) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  emit(event: string, ...args: any[]): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb(...args);
      } catch (e) {
        console.error('[kernel] listener error on ' + event + ':', (e as Error).message);
      }
    }
  }

  /**
   * 加载插件。依赖未就绪时排队，服务注册后自动放行。
   * @returns 插件名（便于日志与断言）
   */
  async plugin(p: Plugin, config?: any): Promise<string> {
    if (this.disposed) throw new Error('context disposed');

    const obj: PluginObject = typeof p === 'function' ? { apply: p } : p;
    const name = obj.name ?? '(anonymous)';
    const deps = obj.inject ?? [];
    const run = async () => {
      await obj.apply(this, config);
    };

    const pending: Pending = { deps, run, name };
    if (this.depsReady(deps)) {
      await run();
    } else {
      this.pending.push(pending);
    }
    await this.flush();
    this.emit('plugin/loaded', name);
    return name;
  }

  private depsReady(deps: string[]): boolean {
    return deps.every((d) => this.services.has(d));
  }

  /** 放行所有依赖已就绪的排队插件 */
  private async flush(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const ready = this.pending.filter((p) => this.depsReady(p.deps));
      if (ready.length === 0) break;
      this.pending = this.pending.filter((p) => !ready.includes(p));
      for (const p of ready) {
        progressed = true;
        try {
          await p.run();
        } catch (e) {
          console.error('[kernel] plugin apply failed: ' + p.name + ':', (e as Error).message);
        }
      }
    }
  }

  /** 尚未满足依赖的插件（便于排障） */
  pendingPlugins(): Array<{ name?: string; missing: string[] }> {
    return this.pending.map((p) => ({
      name: p.name,
      missing: p.deps.filter((d) => !this.services.has(d)),
    }));
  }

  /** 卸载：逆序执行 effect，清空服务与监听 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of [...this.effects].reverse()) {
      try {
        fn();
      } catch (e) {
        console.error('[kernel] effect dispose failed:', (e as Error).message);
      }
    }
    this.effects = [];
    this.services.clear();
    this.listeners.clear();
    this.pending = [];
  }
}
