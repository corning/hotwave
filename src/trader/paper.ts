/**
 * 模拟盘交易引擎（PaperTrader）
 *
 * 内存持仓 + 实时行情撮合，不下真实委托。手续费沿用 PerTrade 规则
 * （佣金 max(5, 0.3‰)，卖出加 1‰ 印花税）。T+1：买入当日不可卖。
 *
 * 持仓快照持久化靠 trades 表（通过 TradeStore 落库），重启时由
 * TradeRouter 调用 replayFromStore 重建。
 */

import { Balance, Position, Entrust, Deal, PerTrade } from './model.js';
import type { ITrader, TradeResult } from './it.js';
import { fetchServerOne } from '../tools/hotwave-server-data.js';

interface PaperPosition {
  stockCode: string;
  stockName: string;
  amount: number;       // 当前数量
  available: number;    // 可用数量（T+1：买入当日为 0，次日开盘后释放）
  costPrice: number;    // 持仓成本价
  buyDate: string;      // 买入日期 YYYY-MM-DD（T+1 判断）
}

export class PaperTrader implements ITrader {
  private cash: number;
  private initialCash: number;
  private positions = new Map<string, PaperPosition>();
  private entrusts: Entrust[] = [];
  private deals: Deal[] = [];

  constructor(initialCash?: number) {
    this.initialCash = initialCash ?? (Number(process.env.PAPER_INITIAL_CASH) || 1_000_000);
    this.cash = this.initialCash;
    console.log(`[PaperTrader] 初始化模拟盘，初始资金 ${this.initialCash}`);
  }

  /** 从 trades 表记录重建持仓与现金（重启后调用） */
  replay(records: Array<{
    stockCode: string; stockName: string; bsType: string;
    price: number; amount: number; cost: number; createdAt: string;
  }>): void {
    this.cash = this.initialCash;
    this.positions.clear();
    this.entrusts = [];
    this.deals = [];
    for (const r of records) {
      if (r.bsType === 'buy') {
        this.applyBuy(r.stockCode, r.stockName, r.price, r.amount, r.cost, r.createdAt.slice(0, 10));
      } else {
        this.applySell(r.stockCode, r.stockName, r.price, r.amount, r.cost, r.createdAt.slice(0, 10));
      }
    }
    console.log(`[PaperTrader] 重放 ${records.length} 笔记录，现金 ${this.cash.toFixed(2)}，持仓 ${this.positions.size} 只`);
    // 重放后释放 T+1：历史买入记录的 buyDate 是过去日期，跨日持仓应已可卖
    this.releaseT1();
  }

  async getBalance(): Promise<Balance[]> {
    let marketValue = 0;
    for (const pos of this.positions.values()) {
      const last = await this.getQuotePrice(pos.stockCode);
      marketValue += last * pos.amount;
    }
    const current = this.cash;
    return [new Balance(current + marketValue, current, this.cash, 0, marketValue, 'CNY')];
  }

  async getPosition(): Promise<Position[]> {
    // 查询持仓前先释放 T+1：跨日持仓的 available 须恢复为可卖，否则始终显示可用 0
    this.releaseT1();
    const out: Position[] = [];
    for (const pos of this.positions.values()) {
      if (pos.amount <= 0) continue;
      const last = await this.getQuotePrice(pos.stockCode);
      out.push(new Position(
        pos.amount,
        pos.available,
        (last - pos.costPrice) * pos.amount,
        pos.costPrice,
        last,
        last * pos.amount,
        '',
        pos.stockCode,
        pos.stockName,
      ));
    }
    return out;
  }

  async getEntrust(): Promise<Entrust[]> {
    return this.entrusts.slice(-50);
  }

  async getCurrentDeal(): Promise<Deal[]> {
    return this.deals.slice(-50);
  }

  async buy(stockCode: string, price: number, amount: number): Promise<TradeResult> {
    const today = this.todayStr();
    const name = await this.fetchName(stockCode);
    const fillPrice = price > 0 ? price : await this.getQuotePrice(stockCode);
    const cost = this.calcCost(amount, fillPrice, 'B');
    const total = fillPrice * amount + cost;
    if (total > this.cash) {
      return { entrustNo: '', status: 'rejected', fillPrice: 0, cost: 0 };
    }
    this.applyBuy(stockCode, name, fillPrice, amount, cost, today);
    const entrustNo = `P${Date.now()}`;
    this.recordEntrust(entrustNo, 'B', amount, fillPrice, stockCode, name, cost);
    this.recordDeal(entrustNo, 'B', amount, fillPrice, stockCode, name);
    return { entrustNo, status: 'filled', fillPrice, cost, stockName: name };
  }

  async sell(stockCode: string, price: number, amount: number): Promise<TradeResult> {
    const today = this.todayStr();
    // 卖出前先释放 T+1：跨日持仓须恢复 available 才能卖出，否则 available 卡在 0 永远拒单
    this.releaseT1();
    const pos = this.positions.get(stockCode);
    if (!pos || pos.available < amount) {
      return { entrustNo: '', status: 'rejected', fillPrice: 0, cost: 0 };
    }
    const name = pos.stockName;
    const fillPrice = price > 0 ? price : await this.getQuotePrice(stockCode);
    const cost = this.calcCost(amount, fillPrice, 'S');
    // 必须在 applySell 之前算 pnl：applySell 会扣减/删除持仓，之后再取 costPrice 会拿到 0
    // pnl = (卖价 - 含买入手续费的持仓成本) × 数量 - 卖出手续费(佣金+印花税)
    // 这样分批卖出时每笔的卖出手续费逐笔计入，盈亏为真实净盈亏
    const pnl = Math.round(((fillPrice - pos.costPrice) * amount - cost) * 100) / 100;
    this.applySell(stockCode, name, fillPrice, amount, cost, today);
    const entrustNo = `P${Date.now()}`;
    this.recordEntrust(entrustNo, 'S', amount, fillPrice, stockCode, name, cost);
    this.recordDeal(entrustNo, 'S', amount, fillPrice, stockCode, name);
    return { entrustNo, status: 'filled', fillPrice, cost, stockName: name, pnl };
  }

  async cancelEntrust(_entrustNo: string): Promise<boolean> {
    // 模拟盘成交即 filled，无可撤单
    return false;
  }

  /** 取实时最新价（hotwave_server 行情端点 /api/hotwave/quote，缓存 + 编码已处理） */
  async getQuotePrice(stockCode: string): Promise<number> {
    try {
      const code = this.normalizeCode(stockCode);
      const { ok, data } = await fetchServerOne('quote', { symbol: code });
      if (!ok) return 0;
      const price = Number(data?.price);
      return Number.isFinite(price) && price > 0 ? price : 0;
    } catch (err) {
      console.error(`[PaperTrader] getQuotePrice ${stockCode} 失败:`, (err as Error).message);
      return 0;
    }
  }

  async fetchName(stockCode: string): Promise<string> {
    try {
      const code = this.normalizeCode(stockCode);
      const { ok, data } = await fetchServerOne('quote', { symbol: code });
      // hotwave_server 已按正确编码解码名称，避免中文股票名乱码落库
      return ok && data?.name ? String(data.name) : stockCode;
    } catch {
      return stockCode;
    }
  }

  // ===== 内部 =====

  private normalizeCode(code: string): string {
    const c = code.trim().toLowerCase();
    if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
    if (/^\d{6}$/.test(c)) {
      if (c.startsWith('6') || c.startsWith('9')) return `sh${c}`;
      if (c.startsWith('8') || c.startsWith('4')) return `bj${c}`;
      return `sz${c}`;
    }
    return c;
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private calcCost(amount: number, price: number, bs: 'B' | 'S'): number {
    const total = amount * price;
    let cost = Math.max(PerTrade.minCost, total * PerTrade.buyCost);
    if (bs === 'S') {
      cost = Math.max(PerTrade.minCost, total * PerTrade.sellCost) + total * PerTrade.closeTax;
    }
    return Math.round(cost * 100) / 100;
  }

  private applyBuy(stockCode: string, stockName: string, price: number, amount: number, cost: number, date: string) {
    const existing = this.positions.get(stockCode);
    if (existing && existing.amount > 0) {
      const newAmount = existing.amount + amount;
      // costPrice 含买入手续费摊入：使持仓成本真实，卖出盈亏自动含买入佣金分摊
      existing.costPrice = (existing.costPrice * existing.amount + price * amount + cost) / newAmount;
      existing.amount = newAmount;
      // T+1：新买入部分当日不可卖；若已是新交易日，旧仓全释放后再扣新仓
      if (existing.buyDate !== date) {
        existing.buyDate = date;
        existing.available = existing.amount - amount;
      }
      // 同日加仓：available 不变（新仓次日释放）
    } else {
      this.positions.set(stockCode, {
        stockCode, stockName,
        amount,
        available: 0, // T+1：当日买入不可卖
        costPrice: (price * amount + cost) / amount, // 含买入手续费
        buyDate: date,
      });
    }
    this.cash -= price * amount + cost;
  }

  private applySell(stockCode: string, stockName: string, price: number, amount: number, cost: number, _date: string) {
    const pos = this.positions.get(stockCode);
    if (!pos) return;
    pos.amount -= amount;
    pos.available -= amount;
    if (pos.amount <= 0) {
      this.positions.delete(stockCode);
    }
    this.cash += price * amount - cost;
  }

  private recordEntrust(entrustNo: string, bs: 'B' | 'S', amount: number, price: number, code: string, name: string, cost: number) {
    this.entrusts.push(new Entrust(entrustNo, bs, amount, price, new Date().toISOString(), '已成', code, name, cost));
  }

  private recordDeal(entrustNo: string, bs: 'B' | 'S', amount: number, price: number, code: string, name: string) {
    const t = new Date();
    const hhmmss = `${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
    this.deals.push(new Deal(`D${Date.now()}`, entrustNo, bs, amount, amount, price, price, hhmmss, code, name));
  }

  /** 释放 T+1 持仓为可卖（跨日时由 Router 调用） */
  releaseT1() {
    const today = this.todayStr();
    for (const pos of this.positions.values()) {
      if (pos.buyDate !== today) {
        pos.available = pos.amount;
      }
    }
  }

  /** 计算卖出相对持仓成本的盈亏（供落库 pnl 用，扣卖出手续费） */
  computePnl(stockCode: string, price: number, amount: number): number {
    const pos = this.positions.get(stockCode);
    if (!pos) return 0;
    const cost = this.calcCost(amount, price, 'S');
    return Math.round(((price - pos.costPrice) * amount - cost) * 100) / 100;
  }
}
