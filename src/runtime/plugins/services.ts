/**
 * 服务插件（基于自研 kernel）
 *
 * 每个服务是一个插件：apply 时 ctx.provide(name, instance)。
 * 依赖方通过 inject: ['approvalPolicy'] 等声明，kernel 负责门控。
 */
import path from 'node:path';
import { resolveWorkspaceDir } from '../../common/paths.js';

const READ_ONLY_TOOLS = new Set([
  'finance_kline', 'finance_10jqka_hot', 'finance_eastmoney_hot', 'finance_f10_data',
  'finance_index_data', 'finance_pankou_data', 'market_anomaly', 'market_big_order',
  'market_analysis',
  'trader_mode', 'trader_balance', 'trader_position', 'trader_entrust', 'trader_deal',
  'trader_stock_info',
]);

const WRITE_TOOLS = new Set(['trader_buy', 'trader_sell', 'trader_cancel', 'trader_login']);

/**
 * 审批策略。
 * 默认 'always-auto'：**含实盘的写类工具一律放行**，不产生审批请求、不阻塞。
 * 代价：实盘无人工二次确认，安全边界只剩 TRADE_MODE + LIVE_TRADE_ENABLED。
 * 'guarded' 为可选回退：只读放行，写类/危险工具需人工。
 */
export class ApprovalPolicy {
  mode: string;
  constructor(mode = process.env.APPROVAL_MODE || 'always-auto') {
    this.mode = mode;
  }
  decide(toolName: string): 'auto' | 'ask' {
    if (this.mode !== 'guarded') return 'auto';
    if (READ_ONLY_TOOLS.has(toolName)) return 'auto';
    return 'ask';
  }
  describe(): string {
    const tradeMode = process.env.TRADE_MODE === 'live' ? 'live' : 'paper';
    const liveReady = process.env.LIVE_TRADE_ENABLED === 'true';
    return 'mode=' + this.mode + ', tradeMode=' + tradeMode + ', liveReady=' + liveReady +
      (this.mode === 'guarded' ? ', 审批=写类需人工' : ', 审批=全部放行(含实盘)');
  }
}

/** 行情数据服务：金融工具的唯一数据入口 */
export class MarketData {
  constructor(private fetcher: (path: string, body?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>) {}
  kline(body: Record<string, unknown>) { return this.fetcher('kline', body); }
  quote(body: Record<string, unknown>) { return this.fetcher('quote', body); }
  f10(body: Record<string, unknown>) { return this.fetcher('f10', body); }
  hot(body: Record<string, unknown>) { return this.fetcher('hot', body); }
}

/** 长期记忆服务（包装 MemoryManager） */
export class MemoryStore {
  manager: any;
  constructor(MemoryManager: any, baseDir = path.join(resolveWorkspaceDir(), 'memory')) {
    if (MemoryManager) this.manager = new MemoryManager(baseDir);
  }
  async load() { return this.manager?.load?.(); }
  async search(query: string, limit = 5) { return this.manager?.search?.(query, limit) ?? []; }
}

/** 定时唤醒服务（骨架；默认不启动，避免误触发真实 LLM） */
export class HeartbeatScheduler {
  timer: any = null;
  constructor(public enabled = false, public intervalMs = 600_000) {}
  start(cb: () => Promise<void>) {
    if (!this.enabled) return false;
    this.timer = setInterval(() => { cb().catch(() => {}); }, this.intervalMs);
    return true;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export type ServiceDeps = {
  /** 工作区（默认 ~/.hotwave/workspace） */
  workspaceDir?: string;
  fetchServerOne: (path: string, body?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>;
  MemoryManager?: any;
};

/** 生成全部服务插件 */
export function createServicePlugins(deps: ServiceDeps) {
  return [
    {
      name: 'approval-policy',
      inject: [],
      apply(ctx: any) {
        ctx.provide('approvalPolicy', new ApprovalPolicy());
      },
    },
    {
      name: 'market-data',
      inject: [],
      apply(ctx: any) {
        ctx.provide('marketData', new MarketData(deps.fetchServerOne));
      },
    },
    {
      name: 'memory-store',
      inject: [],
      apply(ctx: any) {
        ctx.provide('memory', new MemoryStore(
          deps.MemoryManager,
          path.join(deps.workspaceDir ?? resolveWorkspaceDir(), 'memory'),
        ));
      },
    },
    {
      name: 'heartbeat-scheduler',
      inject: [],
      apply(ctx: any) {
        const scheduler = new HeartbeatScheduler(false, 600_000);
        ctx.provide('heartbeatScheduler', scheduler);
        ctx.effect(() => scheduler.stop());
      },
    },
  ];
}
