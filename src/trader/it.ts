/**
 * 交易引擎统一接口
 *
 * 实现者：
 * - RealTrader（EastMoneyTrader，实盘）
 * - PaperTrader（模拟盘，内存撮合 + 实时行情）
 *
 * TradeRouter 按 TRADE_MODE 在两者间路由，统一加风控闸 + 落库。
 */

import type { Balance, Position, Entrust, Deal } from './model.js';

export interface TradeResult {
  /** 委托号（实盘为券商返回，模拟盘为生成的 P<timestamp>） */
  entrustNo: string;
  /** 撮合状态 */
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  /** 实际成交价（模拟盘撮合价） */
  fillPrice: number;
  /** 手续费 */
  cost: number;
  /** 股票名称（模拟盘 fetchName 取得，落库用；实盘可能为空） */
  stockName?: string;
  /** 卖出盈亏（模拟盘卖出时按成本价计算；买入为 0） */
  pnl?: number;
}

export interface ITrader {
  getBalance(): Promise<Balance[]>;
  getPosition(): Promise<Position[]>;
  getEntrust(): Promise<Entrust[]>;
  getCurrentDeal(): Promise<Deal[]>;
  buy(stockCode: string, price: number, amount: number): Promise<TradeResult>;
  sell(stockCode: string, price: number, amount: number): Promise<TradeResult>;
  cancelEntrust(entrustNo: string): Promise<boolean>;
  /** 取实时行情价（模拟盘撮合用） */
  getQuotePrice(stockCode: string): Promise<number>;
}
