/**
 * 股票交易工具集
 *
 * 通过 TradeRouter 路由：按 TRADE_MODE 在模拟盘（PaperTrader）与实盘
 * （EastMoneyTrader）间切换，所有 buy/sell 经风控闸校验并统一落库。
 *
 * 工具：
 * - trader_login: 登录实盘账户（仅实盘模式需要）
 * - trader_mode: 查询当前交易模式与风控状态（决策前自检）
 * - trader_balance / trader_position / trader_entrust / trader_deal: 查询
 * - trader_buy / trader_sell / trader_cancel: 下单（经 TradeRouter 风控闸：仓位/金额/T+1/ST/涨跌停 + 实盘双重确认）
 * - trader_stock_info: 查询股票信息
 *
 * 自动交易受 STRATEGY.md 规则与风控闸约束；模拟盘不下真实委托。
 */

import type { Tool } from "./types.js";
import { EastMoneyTrader } from "../trader/eastmoney.js";
import { TradeRouter } from "../trader/router.js";
import { TradeError } from "../trader/exceptions.js";

// ============== 登录工具（实盘） ==============

export const traderLoginTool: Tool<{
  user?: string;
  password?: string;
}> = {
  name: "trader_login",
  description: "登录东方财富证券实盘交易账户（仅实盘模式需要；模拟盘无需登录）",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      await EastMoneyTrader.getInstance();
      return "登录成功";
    } catch (error) {
      return `登录失败：${(error as Error).message}`;
    }
  },
};

// ============== 交易模式与风控自检 ==============

export const traderModeTool: Tool<{}> = {
  name: "trader_mode",
  description: "查询当前交易模式（paper 模拟盘 / live 实盘）与风控状态，下单前应先调用自检。实盘模式（liveReady=true）下下单将提交真实委托，受交易时段/ST/涨跌停/仓位/金额/每日次数风控约束",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      return JSON.stringify(router.status(), null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询账户资金 ==============

export const traderBalanceTool: Tool<{}> = {
  name: "trader_balance",
  description: "查询账户资金状况（总资产、可用资金、冻结资金、市值等）",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      const balances = await router.getBalance();

      if (!balances || balances.length === 0) {
        return "未获取到资金信息";
      }

      const balance = balances[0];
      const result = {
        "总资产": balance.assetBalance,
        "当前余额": balance.currentBalance,
        "可用资金": balance.enableBalance,
        "冻结资金": balance.frozenBalance,
        "市值": balance.marketValue,
        "币种": balance.moneyType,
        "模式": router.getMode(),
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询持仓 ==============

export const traderPositionTool: Tool<{}> = {
  name: "trader_position",
  description: "查询当前持仓股票列表",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      const positions = await router.getPosition();

      if (!positions || positions.length === 0) {
        return "当前无持仓";
      }

      const result = positions.map(pos => ({
        "股票代码": pos.stockCode,
        "股票名称": pos.stockName,
        "当前数量": pos.currentAmount,
        "可用数量": pos.enableAmount,
        "成本价": pos.costPrice,
        "最新价": pos.lastPrice,
        "市值": pos.marketValue,
        "盈亏": pos.incomeBalance,
      }));

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询当日委托 ==============

export const traderEntrustTool: Tool<{}> = {
  name: "trader_entrust",
  description: "查询当日委托列表",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      const entrusts = await router.getEntrust();

      if (!entrusts || entrusts.length === 0) {
        return "当日无委托";
      }

      const result = entrusts.map(e => ({
        "委托编号": e.entrustNo,
        "股票代码": e.stockCode,
        "股票名称": e.stockName,
        "买卖类别": e.bsType,
        "委托数量": e.entrustAmount,
        "委托价格": e.entrustPrice,
        "申报时间": e.reportTime,
        "委托状态": e.entrustStatus,
      }));

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询当日成交 ==============

export const traderDealTool: Tool<{}> = {
  name: "trader_deal",
  description: "查询当日成交列表",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      const deals = await router.getCurrentDeal();

      if (!deals || deals.length === 0) {
        return "当日无成交";
      }

      const result = deals.map(d => ({
        "成交编号": d.dealNo,
        "委托编号": d.entrustNo,
        "股票代码": d.stockCode,
        "股票名称": d.stockName,
        "买卖类别": d.bsType,
        "委托数量": d.entrustAmount,
        "成交数量": d.dealAmount,
        "成交价格": d.dealPrice,
        "委托价格": d.entrustPrice,
        "成交时间": d.dealTime,
      }));

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 买入股票 ==============

export const traderBuyTool: Tool<{
  stock_code: string;
  price: number;
  amount: number;
  strategy_tag?: string;
  reason?: string;
}> = {
  name: "trader_buy",
  description: "买入股票（经风控闸：自动交易开关、单票仓位上限、单笔金额上限；模拟盘不下真实委托）",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 '600000'" },
      price: { type: "number", description: "买入价格（0 表示用最新价）" },
      amount: { type: "number", description: "买入股数（100 的整数倍）" },
      strategy_tag: { type: "string", description: "策略标签，如 heartbeat/alert/manual，默认 manual" },
      reason: { type: "string", description: "本次买入的策略原因/决策依据，将写入执行日志供用户复盘，如『突破前高放量，MACD金叉』" },
    },
    required: ["stock_code", "price", "amount"],
  },
  async execute(input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      return await router.buy(input.stock_code, input.price, input.amount, input.strategy_tag || 'manual', input.reason || '');
    } catch (error) {
      if (error instanceof TradeError) {
        return `买入失败：${error.message}`;
      }
      return `买入失败：${(error as Error).message}`;
    }
  },
};

// ============== 卖出股票 ==============

export const traderSellTool: Tool<{
  stock_code: string;
  price: number;
  amount: number;
  strategy_tag?: string;
  reason?: string;
}> = {
  name: "trader_sell",
  description: "卖出股票（经风控闸；模拟盘 T+1 限制：买入当日不可卖）",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 '600000'" },
      price: { type: "number", description: "卖出价格（0 表示用最新价）" },
      amount: { type: "number", description: "卖出股数" },
      strategy_tag: { type: "string", description: "策略标签，如 heartbeat/alert/manual，默认 manual" },
      reason: { type: "string", description: "本次卖出的策略原因/决策依据，将写入执行日志供用户复盘，如『触及止盈+10%』『破位止损』" },
    },
    required: ["stock_code", "price", "amount"],
  },
  async execute(input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      return await router.sell(input.stock_code, input.price, input.amount, input.strategy_tag || 'manual', input.reason || '');
    } catch (error) {
      if (error instanceof TradeError) {
        return `卖出失败：${error.message}`;
      }
      return `卖出失败：${(error as Error).message}`;
    }
  },
};

// ============== 撤销委托 ==============

export const traderCancelTool: Tool<{
  entrust_no: string;
}> = {
  name: "trader_cancel",
  description: "撤销委托单（实盘有效；模拟盘成交即 filled，无可撤单）",
  inputSchema: {
    type: "object",
    properties: {
      entrust_no: { type: "string", description: "委托编号" },
    },
    required: ["entrust_no"],
  },
  async execute(input, _ctx) {
    try {
      const router = await TradeRouter.getInstance();
      const success = await router.cancelEntrust(input.entrust_no);
      if (success) {
        return `委托 ${input.entrust_no} 撤销成功`;
      } else {
        return `委托 ${input.entrust_no} 撤销失败`;
      }
    } catch (error) {
      return `撤销失败：${(error as Error).message}`;
    }
  },
};

// ============== 查询股票信息 ==============

export const traderStockInfoTool: Tool<{
  stock_code: string;
}> = {
  name: "trader_stock_info",
  description: "查询股票信息（名称、市场、涨跌停价格等）",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 '600000'" },
    },
    required: ["stock_code"],
  },
  async execute(input, _ctx) {
    try {
      // 模拟盘不需要登录实盘账户：getStockInfo 属于券商接口，未开启实盘时直接说明
      if (process.env.TRADE_MODE !== 'live' || process.env.LIVE_TRADE_ENABLED !== 'true') {
        return "模拟盘模式：不登录实盘账户，无法获取交易所级股票信息（涨停/跌停价）。请改用 finance_pankou_data 获取行情与名称。";
      }
      const trader = await EastMoneyTrader.getInstance();
      const stockInfo = await (trader as any).getStockInfo(input.stock_code);

      const result = {
        "股票代码": stockInfo.Code,
        "股票名称": stockInfo.Name,
        "市场": stockInfo.Market,
        "涨停价": stockInfo.MaxPrice,
        "跌停价": stockInfo.MinPrice,
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `查询失败：${(error as Error).message}`;
    }
  },
};

// ============== 工具列表导出 ==============

export const traderTools = [
  traderLoginTool,
  traderModeTool,
  traderBalanceTool,
  traderPositionTool,
  traderEntrustTool,
  traderDealTool,
  traderBuyTool,
  traderSellTool,
  traderCancelTool,
  traderStockInfoTool,
];
