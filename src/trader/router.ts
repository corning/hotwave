/**
 * TradeRouter — 交易路由 + 风控闸 + 落库
 *
 * 按 TRADE_MODE 在 PaperTrader / EastMoneyTrader 间路由。所有 buy/sell
 * 经风控闸校验（总开关、单票仓位上限、单笔金额上限、实盘双重确认），
 * 成交后统一调 TradeStore 落库。
 *
 * 对外暴露与 trader.ts 工具对接的方法（返回 JSON 字符串，保持与原
 * EastMoneyTrader 工具一致的输出契约）。
 */

import { EastMoneyTrader } from './eastmoney.js';
import { PaperTrader } from './paper.js';
import { TradeError } from './exceptions.js';
import { recordTrade, recordExecutionLog, fetchTrades, isConfigured } from './trade-store.js';

type Mode = 'paper' | 'live';

interface RiskConfig {
  tradeMode: Mode;
  liveTradeEnabled: boolean;
  maxPositionRatio: number;
  maxOrderAmount: number;
  /** 实盘是否仅允许在 A 股交易时段下单（默认 true） */
  liveSessionOnly: boolean;
  /** 实盘每日下单次数上限（默认 20） */
  maxLiveOrdersPerDay: number;
}

function loadConfig(): RiskConfig {
  return {
    tradeMode: (process.env.TRADE_MODE === 'live' ? 'live' : 'paper') as Mode,
    liveTradeEnabled: process.env.LIVE_TRADE_ENABLED === 'true',
    maxPositionRatio: Number(process.env.MAX_POSITION_RATIO) || 0.3,
    maxOrderAmount: Number(process.env.MAX_ORDER_AMOUNT) || 100_000,
    liveSessionOnly: process.env.LIVE_TRADE_SESSION_ONLY !== 'false',
    maxLiveOrdersPerDay: Number(process.env.MAX_LIVE_ORDERS_PER_DAY) || 20,
  };
}

/** 判断当前是否处于 A 股交易时段（北京时间 09:25-11:30, 13:00-15:00） */
function isAshareTradingSession(): boolean {
  const now = new Date();
  // 服务器时区若非 Asia/Shanghai，按 UTC+8 计算
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  const day = bj.getDay();
  if (day === 0 || day === 6) return false; // 周末
  const hhmm = bj.getHours() * 100 + bj.getMinutes();
  return (hhmm >= 925 && hhmm <= 1130) || (hhmm >= 1300 && hhmm <= 1500);
}

export class TradeRouter {
  private static instance: TradeRouter | null = null;
  private paper: PaperTrader;
  private cfg: RiskConfig;
  private initialized = false;
  /** 实盘每日下单计数：key=YYYY-MM-DD(北京)，value=当日已下单次数 */
  private liveOrderCount = new Map<string, number>();

  private constructor() {
    this.cfg = loadConfig();
    this.paper = new PaperTrader();
    const liveTag = this.isLiveReady() ? '⚠️实盘已就绪(真金白银)' : '实盘未就绪';
    console.log(`[TradeRouter] 模式=${this.cfg.tradeMode} ${liveTag} 实盘时段限制=${this.cfg.liveSessionOnly} 每日上限=${this.cfg.maxLiveOrdersPerDay}`);
  }

  /** 当日实盘下单计数（北京日期） */
  private todayKey(): string {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
    const bj = new Date(utc + 8 * 3600_000);
    return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`;
  }

  private bumpLiveOrderCount(): number {
    const key = this.todayKey();
    const n = (this.liveOrderCount.get(key) ?? 0) + 1;
    this.liveOrderCount.set(key, n);
    return n;
  }

  static async getInstance(): Promise<TradeRouter> {
    if (!TradeRouter.instance) {
      TradeRouter.instance = new TradeRouter();
    }
    await TradeRouter.instance.ensureInit();
    return TradeRouter.instance;
  }

  /** 首次使用时从 trades 表重放 PaperTrader 持仓 */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (isConfigured()) {
      try {
        const records = await fetchTrades('paper');
        if (records.length > 0) {
          this.paper.replay(records.map((r) => ({
            stockCode: r.stock_code,
            stockName: r.stock_name,
            bsType: r.bs_type,
            price: r.price,
            amount: r.amount,
            cost: r.cost,
            createdAt: r.created_at,
          })));
        }
      } catch (err) {
        console.error('[TradeRouter] 重放交易记录失败:', (err as Error).message);
      }
    }
  }

  getMode(): Mode {
    return this.cfg.tradeMode;
  }

  /** 实盘是否真正可用：TRADE_MODE=live 且 LIVE_TRADE_ENABLED=true */
  isLiveReady(): boolean {
    return this.cfg.tradeMode === 'live' && this.cfg.liveTradeEnabled;
  }

  /** 风控状态自检（供 trader_mode 工具） */
  status() {
    const liveReady = this.isLiveReady();
    const inSession = isAshareTradingSession();
    return {
      mode: this.cfg.tradeMode,
      liveReady,
      maxPositionRatio: this.cfg.maxPositionRatio,
      maxOrderAmount: this.cfg.maxOrderAmount,
      storeConfigured: isConfigured(),
      inTradingSession: inSession,
      liveSessionOnly: this.cfg.liveSessionOnly,
      liveOrdersToday: this.liveOrderCount.get(this.todayKey()) ?? 0,
      maxLiveOrdersPerDay: this.cfg.maxLiveOrdersPerDay,
      warning: liveReady
        ? '⚠️ 实盘模式已就绪：下单将提交真实委托！所有 buy/sell 受交易时段、ST、涨跌停、仓位、金额、每日次数风控约束。'
        : undefined,
    };
  }

  async getBalance() {
    return this.isLiveReady()
      ? (await EastMoneyTrader.getInstance()).getBalance()
      : this.paper.getBalance();
  }

  async getPosition() {
    return this.isLiveReady()
      ? (await EastMoneyTrader.getInstance()).getPosition()
      : this.paper.getPosition();
  }

  async getEntrust() {
    return this.isLiveReady()
      ? (await EastMoneyTrader.getInstance()).getEntrust()
      : this.paper.getEntrust();
  }

  async getCurrentDeal() {
    return this.isLiveReady()
      ? (await EastMoneyTrader.getInstance()).getCurrentDeal()
      : this.paper.getCurrentDeal();
  }

  async buy(stockCode: string, price: number, amount: number, strategyTag = 'manual', reason = ''): Promise<string> {
    const reasonSection = reason.trim() ? `原因：${reason.trim()}。` : '';
    try {
      await this.checkOrderRisk(stockCode, price, amount, 'buy');
      if (this.isLiveReady()) {
        await this.checkLiveOrderRisk(stockCode, price, amount, 'buy');
        const trader = await EastMoneyTrader.getInstance();
        await trader.buy(stockCode, price, amount);
        this.bumpLiveOrderCount();
        // 实盘仅提交委托，成交与否需后续 getEntrust/getCurrentDeal 确认，故落 pending
        // 实盘委托落 pending：pnlOrStatus 位传 0（number），statusExplicit 位传 'pending'；勿把 'pending' 塞进 pnlOrStatus 位（会落成 filled）
        const p = await this.persist('live', stockCode, '', price, amount, 'buy', '', strategyTag, price, 0, 0, 'pending');
        const mode = this.cfg.tradeMode;
        await recordExecutionLog({
          mode,
          title: `提交买入委托 ${stockCode}`,
          description: `以 ${price.toFixed(2)} 元买入 ${amount} 股，策略标签：${strategyTag}。${reasonSection}委托状态：pending，待成交确认。`,
          status: 'pending',
          logType: 'trade',
          strategyTag,
        });
        return `⚠️实盘买入委托已提交（pending，待成交确认）：${stockCode}，价格 ${price}，数量 ${amount}${p.ok ? '' : `\n⚠️警告：${p.error}`}`;
      }
      const res = await this.paper.buy(stockCode, price, amount);
      if (res.status !== 'filled') throw new TradeError(`模拟盘买入失败（资金不足）：${stockCode}`);
      const p = await this.persist('paper', stockCode, res.stockName ?? '', res.fillPrice, amount, 'buy', res.entrustNo, strategyTag, res.fillPrice, res.cost);
      const mode = this.cfg.tradeMode;
      await recordExecutionLog({
        mode,
        title: `买入 ${res.stockName ?? stockCode}(${stockCode})`,
        description: `以 ${res.fillPrice.toFixed(2)} 元买入 ${amount} 股，策略标签：${strategyTag}。${reasonSection}`,
        status: 'success',
        logType: 'trade',
        tradeId: p.rowId,
        strategyTag,
      });
      const warn = p.ok ? '' : `\n⚠️警告：交易已成交但记录未落库（${p.error}），APP 交易记录页将看不到此笔。`;
      return `模拟盘买入成交：${stockCode}，价格 ${res.fillPrice}，数量 ${amount}，委托号 ${res.entrustNo}${warn}`;
    } catch (err) {
      const msg = err instanceof TradeError ? err.message : String(err);
      await recordExecutionLog({
        mode: this.cfg.tradeMode,
        title: `买入 ${stockCode} 被拦截`,
        description: `${msg}${reasonSection ? ' ' + reasonSection : ''}`,
        status: 'failure',
        logType: 'risk_control',
        strategyTag,
      });
      throw err;
    }
  }

  async sell(stockCode: string, price: number, amount: number, strategyTag = 'manual', reason = ''): Promise<string> {
    const reasonSection = reason.trim() ? `原因：${reason.trim()}。` : '';
    try {
      await this.checkOrderRisk(stockCode, price, amount, 'sell');
      if (this.isLiveReady()) {
        await this.checkLiveOrderRisk(stockCode, price, amount, 'sell');
        const trader = await EastMoneyTrader.getInstance();
        await trader.sell(stockCode, price, amount);
        this.bumpLiveOrderCount();
        // 同 buy：pnlOrStatus 位传 0，statusExplicit 位传 'pending'
        const p = await this.persist('live', stockCode, '', price, amount, 'sell', '', strategyTag, price, 0, 0, 'pending');
        const mode = this.cfg.tradeMode;
        await recordExecutionLog({
          mode,
          title: `提交卖出委托 ${stockCode}`,
          description: `以 ${price.toFixed(2)} 元卖出 ${amount} 股，策略标签：${strategyTag}。${reasonSection}委托状态：pending，待成交确认。`,
          status: 'pending',
          logType: 'trade',
          strategyTag,
        });
        return `⚠️实盘卖出委托已提交（pending，待成交确认）：${stockCode}，价格 ${price}，数量 ${amount}${p.ok ? '' : `\n⚠️警告：${p.error}`}`;
      }
      const res = await this.paper.sell(stockCode, price, amount);
      if (res.status !== 'filled') throw new TradeError(`模拟盘卖出失败（持仓不足或 T+1 限制）：${stockCode}`);
      const pnl = res.pnl ?? this.paper.computePnl(stockCode, res.fillPrice, amount);
      // persist 第 10 位是 cost（手续费）、第 11 位是 pnl；勿颠倒，否则落库 cost=盈亏导致 replay 现金高估
      const p = await this.persist('paper', stockCode, res.stockName ?? '', res.fillPrice, amount, 'sell', res.entrustNo, strategyTag, res.fillPrice, res.cost, pnl);
      const mode = this.cfg.tradeMode;
      await recordExecutionLog({
        mode,
        title: `卖出 ${res.stockName ?? stockCode}(${stockCode})`,
        description: `以 ${res.fillPrice.toFixed(2)} 元卖出 ${amount} 股，盈亏 ${pnl.toFixed(2)}，策略标签：${strategyTag}。${reasonSection}`,
        status: 'success',
        logType: 'trade',
        tradeId: p.rowId,
        strategyTag,
      });
      const warn = p.ok ? '' : `\n⚠️警告：交易已成交但记录未落库（${p.error}），APP 交易记录页将看不到此笔。`;
      return `模拟盘卖出成交：${stockCode}，价格 ${res.fillPrice}，数量 ${amount}，委托号 ${res.entrustNo}，盈亏 ${pnl}${warn}`;
    } catch (err) {
      const msg = err instanceof TradeError ? err.message : String(err);
      await recordExecutionLog({
        mode: this.cfg.tradeMode,
        title: `卖出 ${stockCode} 被拦截`,
        description: `${msg}${reasonSection ? ' ' + reasonSection : ''}`,
        status: 'failure',
        logType: 'risk_control',
        strategyTag,
      });
      throw err;
    }
  }

  /**
   * 一键清仓：遍历真实账户持仓，逐只提交卖出委托。
   * 风控取舍：保留交易时段闸 + T+1（enableAmount=0 跳过）+ 涨跌停（_trade 内）+ 落库 pending；
   * 跳过 maxOrderAmount/maxLiveOrdersPerDay/ST（清仓是用户主动全卖，AI 防失控风控不适用）。
   * 仅实盘（isLiveReady）；非交易时段拒。
   */
  async liquidate(reason = '一键清仓'): Promise<{
    liquidated: { stockCode: string; stockName: string; amount: number; price: number; status: string }[];
    failed: { stockCode: string; error: string }[];
    skipped: { stockCode: string; reason: string }[];
    submitted: number;
  }> {
    if (!this.isLiveReady()) {
      throw new TradeError('清仓仅支持真实账户（实盘模式未就绪）');
    }
    if (!isAshareTradingSession()) {
      throw new TradeError('当前非 A 股交易时段（北京时间 09:25-11:30 / 13:00-15:00），禁止清仓');
    }
    const trader = await EastMoneyTrader.getInstance();
    const positions = await trader.getPosition();
    const liquidated: { stockCode: string; stockName: string; amount: number; price: number; status: string }[] = [];
    const failed: { stockCode: string; error: string }[] = [];
    const skipped: { stockCode: string; reason: string }[] = [];

    for (const p of positions) {
      if (p.currentAmount <= 0) continue;
      if (p.enableAmount <= 0) {
        skipped.push({ stockCode: p.stockCode, reason: '可用数量为0（T+1 当日买入不可卖）' });
        continue;
      }
      const price = p.lastPrice > 0 ? p.lastPrice : p.costPrice;
      try {
        await trader.sell(p.stockCode, price, p.enableAmount);
        this.bumpLiveOrderCount();
        await this.persist('live', p.stockCode, p.stockName, price, p.enableAmount, 'sell', '', 'liquidate', price, 0, 0, 'pending');
        await recordExecutionLog({
          mode: this.cfg.tradeMode,
          title: `清仓卖出 ${p.stockName}(${p.stockCode})`,
          description: `一键清仓：卖出 ${p.enableAmount} 股 @ ${price.toFixed(2)}，委托状态 pending（待成交确认）。${reason}`,
          status: 'pending',
          logType: 'trade',
          strategyTag: 'liquidate',
        });
        liquidated.push({ stockCode: p.stockCode, stockName: p.stockName, amount: p.enableAmount, price, status: 'pending' });
      } catch (err) {
        const msg = err instanceof TradeError ? err.message : String(err);
        await recordExecutionLog({
          mode: this.cfg.tradeMode,
          title: `清仓失败 ${p.stockName}(${p.stockCode})`,
          description: `一键清仓卖出失败：${msg}`,
          status: 'failure',
          logType: 'risk_control',
          strategyTag: 'liquidate',
        });
        failed.push({ stockCode: p.stockCode, error: msg });
      }
    }
    return { liquidated, failed, skipped, submitted: liquidated.length };
  }

  async cancelEntrust(entrustNo: string): Promise<boolean> {
    if (this.isLiveReady()) {
      const trader = await EastMoneyTrader.getInstance();
      return trader.cancelEntrust(entrustNo);
    }
    return this.paper.cancelEntrust(entrustNo);
  }

  async getQuotePrice(stockCode: string): Promise<number> {
    return this.paper.getQuotePrice(stockCode);
  }

  // ===== 风控 =====

  /** 单笔金额 + 单票仓位风控 */
  private async checkOrderRisk(stockCode: string, price: number, amount: number, bs: 'buy' | 'sell') {
    // 交易时段风控（实盘+模拟盘通用）：非 A 股交易时段拒下单
    // （模拟盘原无时段限制；非交易日 heartbeat 已不唤醒 LLM，此处为兜底，防手动/其他路径在非交易时段下单）
    if (!isAshareTradingSession()) {
      throw new TradeError('当前非 A 股交易时段（北京时间 09:25-11:30 / 13:00-15:00），禁止下单');
    }
    const orderAmount = price * amount;
    if (orderAmount > this.cfg.maxOrderAmount) {
      throw new TradeError(`单笔金额 ${orderAmount.toFixed(2)} 超过上限 ${this.cfg.maxOrderAmount}`);
    }
    if (bs === 'buy') {
      const balance = this.isLiveReady()
        ? await (await EastMoneyTrader.getInstance()).getBalance()
        : await this.paper.getBalance();
      const totalAsset = balance[0]?.assetBalance || 0;
      if (totalAsset > 0) {
        const positions = this.isLiveReady()
          ? await (await EastMoneyTrader.getInstance()).getPosition()
          : await this.paper.getPosition();
        const existing = positions.find((p) => p.stockCode === stockCode);
        const heldValue = existing ? existing.marketValue : 0;
        const ratio = (heldValue + orderAmount) / totalAsset;
        if (ratio > this.cfg.maxPositionRatio) {
          throw new TradeError(`下单后 ${stockCode} 仓位占比 ${(ratio * 100).toFixed(1)}% 超过上限 ${this.cfg.maxPositionRatio * 100}%`);
        }
      }
    }
  }

  /**
   * 实盘专属风控（仅在 isLiveReady 时调用）：
   * - 交易时段校验（盘中 09:25-11:30 / 13:00-15:00）
   * - 每日实盘下单次数上限
   * - 必须明确限价（实盘不接受 price=0）
   * - ST/*ST 禁买禁卖
   * - 涨停封死禁买、跌停封死禁卖
   * - 卖出须有可用持仓
   */
  private async checkLiveOrderRisk(stockCode: string, price: number, amount: number, bs: 'buy' | 'sell') {
    if (this.cfg.liveSessionOnly && !isAshareTradingSession()) {
      throw new TradeError('实盘下单仅允许在 A 股交易时段（北京时间 09:25-11:30 / 13:00-15:00）内执行');
    }
    const today = this.todayKey();
    if ((this.liveOrderCount.get(today) ?? 0) >= this.cfg.maxLiveOrdersPerDay) {
      throw new TradeError(`今日实盘下单次数已达上限 ${this.cfg.maxLiveOrdersPerDay}，拒绝继续下单（防失控）`);
    }
    if (price <= 0) {
      throw new TradeError('实盘下单必须提供明确的限价（price=0 仅模拟盘可用）');
    }

    const trader = await EastMoneyTrader.getInstance();
    const info = await (trader as unknown as {
      getStockInfo(code: string): Promise<{ Name: string; MaxPrice: number; MinPrice: number }>;
    }).getStockInfo(stockCode);

    if (info.Name.includes('ST') || info.Name.includes('退')) {
      throw new TradeError(`实盘禁止交易 ST/退市股票：${info.Name}(${stockCode})`);
    }

    if (bs === 'buy') {
      // 涨停封死（买一价已达涨停）则买不进
      if (price >= info.MaxPrice) {
        throw new TradeError(`${stockCode} 买入价 ${price} 已达涨停价 ${info.MaxPrice}（封死涨停无法买入）`);
      }
      if (price < info.MinPrice) {
        throw new TradeError(`${stockCode} 买入价 ${price} 低于跌停价 ${info.MinPrice}（价格非法）`);
      }
    } else {
      if (price <= info.MinPrice) {
        throw new TradeError(`${stockCode} 卖出价 ${price} 已达跌停价 ${info.MinPrice}（封死跌停无法卖出）`);
      }
      if (price > info.MaxPrice) {
        throw new TradeError(`${stockCode} 卖出价 ${price} 超过涨停价 ${info.MaxPrice}（价格非法）`);
      }
      // 卖出须有足够可用持仓
      const positions = await trader.getPosition();
      const pos = positions.find((p) => p.stockCode === stockCode);
      const available = pos?.enableAmount ?? 0;
      if (available < amount) {
        throw new TradeError(`${stockCode} 可用持仓 ${available} 股不足，无法卖出 ${amount} 股（含 T+1 限制）`);
      }
    }
  }

  // ===== 落库 =====

  /**
   * 落库一笔交易。返回 { ok, error? }：成交已发生不回滚，仅当落库失败时返回 error，
   * 由 buy/sell 追加到 Agent 反馈串，让"成交但未落库"对 Agent 可见（不再静默吞掉）。
   */
  private async persist(
    mode: Mode, stockCode: string, stockName: string, price: number, amount: number,
    bsType: 'buy' | 'sell', entrustNo: string, strategyTag: string,
    fillPrice: number, cost: number, pnlOrStatus?: number | string,
    statusExplicit?: 'pending' | 'filled',
  ): Promise<{ ok: boolean; rowId?: number; error?: string }> {
    // 实盘委托落 pending（未必成交）；模拟盘成交落 filled
    const status = statusExplicit ?? 'filled';
    const pnl = typeof pnlOrStatus === 'number' ? pnlOrStatus : 0;
    const total = fillPrice * amount;
    try {
      const result = await recordTrade({
        mode,
        stockCode,
        stockName,
        bsType,
        price: fillPrice,
        amount,
        cost,
        total,
        status,
        entrustNo,
        strategyTag,
        pnl,
      });
      if (!result.ok) {
        console.error('[TradeRouter] 落库失败:', result.error);
        return { ok: false, error: result.error };
      }
      return { ok: true, rowId: result.row?.id };
    } catch (err) {
      console.error('[TradeRouter] 落库异常:', (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
  }
}
