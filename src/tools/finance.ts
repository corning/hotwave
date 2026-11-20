/**
 * 金融数据工具集
 *
 * 数据统一由 hotwave_server 提供（独立数据端点 /api/hotwave/*），hotwave 不直连外部。
 * - finance_10jqka_hot: A股/ETF 热股风格排名
 * - finance_eastmoney_hot: 热门股排名（A股热榜/涨幅榜/ETF/港股/美股）
 * - finance_f10_data: 个股 F10 基本面数据（基础信息/指标/板块/风险等）
 * - finance_index_data: 指数行情
 * - finance_pankou_data: 个股盘口数据
 * - finance_kline / market_analysis
 */

import type { Tool } from "./types.js";
import { fetchServerOne } from "./hotwave-server-data.js";

// ============== A股/ETF 热股风格排名 ==============

export const finance10jqkaHotTool: Tool<{
  stock_type?: string;
  type?: string;
  list_type?: string;
  limit?: number;
}> = {
  name: "finance_10jqka_hot",
  description: "获取A股和ETF的热股排名数据，参数可选",
  inputSchema: {
    type: "object",
    properties: {
      stock_type: { type: "string", description: "股票类型，默认 'a'" },
      type: { type: "string", description: "时间范围: 'hour'(小时) 或 'day'(日)，默认 'hour'" },
      list_type: { type: "string", description: "榜单类型: 'normal'(普通), 'skyrocket'(暴涨), 'tech'(技术), 'value'(价值), 'trend'(趋势)，默认 'normal'" },
      limit: { type: "number", description: "返回条数（默认 20，最多 50）。bug-263: 原 100 条全量 + 缩进 = 8.7KB" },
    },
  },
  async execute(input, _ctx) {
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
    const { ok, data, error } = await fetchServerOne("hot", {
      stock_type: input.stock_type,
      period: input.type,
      list_type: input.list_type,
      limit,
    });
    if (!ok) return `请求失败: ${error}`;
    const items = Array.isArray(data) ? data : [];
    return JSON.stringify({ count: items.length, items });
  },
};

// ============== 热门股排名 ==============

export const financeEastmoneyHotTool: Tool<{
  type?: string;
  limit?: number;
}> = {
  name: "finance_eastmoney_hot",
  description: "获取热门股票排名数据，支持A股热榜、涨幅榜、ETF热榜、港股、美股",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "榜单类型: 'hot'(A股热榜), 'rise'(涨幅榜), 'etf'(ETF热榜), 'hk'(港股), 'us'(美股)，默认 'hot'",
      },
      limit: {
        type: "number",
        description: "返回条数（默认 20，最多 50）。bug-263: 原 100 条全量 + 格式化缩进返回 40KB 进 session",
      },
    },
  },
  async execute(input, _ctx) {
    const type = input.type ?? "hot";
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
    const { ok, data, error } = await fetchServerOne("hot", { type, limit });
    if (!ok) return `请求失败: ${error}`;
    const items = Array.isArray(data) ? data : [];
    return JSON.stringify({ type, count: items.length, items });
  },
};

// ============== F10 基本面数据 ==============

export const financeF10DataTool: Tool<{
  type: string;
  code: string;
}> = {
  name: "finance_f10_data",
  description: "获取个股F10基本面数据，支持基础信息、风险扫雷、筹码集中度、最新指标、PE预测、报表披露、板块题材、融资融券等",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "数据类型: 'base'(基础信息), 'risk'(风险扫雷), 'hold'(筹码集中度), 'indicator'(最新指标-最重要), 'pepre'(PE预测), 'index'(报表披露/龙虎榜等), 'board'(板块题材概念), 'margin'(历史融资融券)",
      },
      code: {
        type: "string",
        description: "股票代码，带市场后缀，如 '002074.SZ'、'600000.SH'",
      },
    },
    required: ["type", "code"],
  },
  async execute(input, _ctx) {
    const { ok, data, error } = await fetchServerOne("f10", { type: input.type, symbol: input.code });
    if (!ok) return `请求失败: ${error}`;
    return JSON.stringify(data, null, 2);
  },
};

// ============== 指数行情数据 ==============

export const financeIndexDataTool: Tool<{
  codes: string;
}> = {
  name: "finance_index_data",
  description: "获取指数行情数据，支持沪深指数、港股指数等。返回指数名称、最新价、涨跌幅等",
  inputSchema: {
    type: "object",
    properties: {
      codes: {
        type: "string",
        description: "指数代码列表，逗号分隔，如 'sh000001,sz399001'。常用: sh000001(上证), sz399001(深证), sz399006(创业板), sh000688(科创50), r_hkHSI(恒生指数)",
      },
    },
    required: ["codes"],
  },
  async execute(input, _ctx) {
    const codes = String(input.codes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (codes.length === 0) return "未获取到指数数据";

    const settled = await Promise.allSettled(codes.map((c) => fetchServerOne("quote", { symbol: c })));
    const result: Record<string, unknown> = {};
    codes.forEach((c, i) => {
      const r = settled[i];
      if (r.status === "fulfilled" && r.value.ok && r.value.data) {
        const d = r.value.data;
        result[c] = {
          name: d.name,
          price: d.price,
          change: d.change,
          change_pct: d.pctChg,
          open: d.open,
          high: d.high,
          low: d.low,
          pre_close: d.preClose,
          volume: d.volume,
        };
      }
    });
    if (Object.keys(result).length === 0) return "未获取到指数数据";
    return JSON.stringify(result, null, 2);
  },
};

// ============== 个股盘口数据 ==============

export const financePankouDataTool: Tool<{
  code: string;
}> = {
  name: "finance_pankou_data",
  description: "获取个股盘口数据，含名称、最新价、开盘价、最低价、五档买卖盘",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "股票代码，含市场前缀，如 'sh600000'(上证)、'sz002074'(深证)",
      },
    },
    required: ["code"],
  },
  async execute(input, _ctx) {
    const { ok, data, error } = await fetchServerOne("quote", { symbol: input.code });
    if (!ok) return `请求失败: ${error}`;
    if (!data) return "未获取到盘口数据";

    const buy = Array.isArray(data.buy)
      ? data.buy.map((b: { price: number; volume: number }) => [b.price, b.volume])
      : [];
    const sell = Array.isArray(data.sell)
      ? data.sell.map((s: { price: number; volume: number }) => [s.price, s.volume])
      : [];

    const result = {
      code: input.code,
      name: data.name,
      price: data.price,
      low: data.low,
      open: data.open,
      buy1: buy[0],
      buy2: buy[1],
      buy3: buy[2],
      buy4: buy[3],
      buy5: buy[4],
      sell1: sell[0],
      sell2: sell[1],
      sell3: sell[2],
      sell4: sell[3],
      sell5: sell[4],
    };
    return JSON.stringify(result, null, 2);
  },
};

// ============== 异动检测工具 ==============

/**
 * 沪深主板异动票池 — 涨幅区间 + 市值筛选。
 * 数据由 hotwave_server 提供（/api/hotwave/market），hotwave 不直连外部。
 */
export const financeMarketAnomalyTool: Tool<{
  riseMin?: number;
  riseMax?: number;
  marketValueMax?: number;
  limit?: number;
}> = {
  name: "market_anomaly",
  description: "获取沪深主板异动票池：涨幅在区间内（默认 6%~9.9%）且市值不超过上限的股票列表，含名称、现价、涨幅、总市值、换手率、成交额，用于盘中发现放量异动标的",
  inputSchema: {
    type: "object",
    properties: {
      riseMin: { type: "number", description: "涨幅下限（%），默认 6" },
      riseMax: { type: "number", description: "涨幅上限（%），默认 9.9" },
      marketValueMax: { type: "number", description: "总市值上限（亿元），默认 500，<=0 表示不限" },
      limit: { type: "number", description: "返回条数（默认 20，最多 50）" },
    },
  },
  async execute(input, _ctx) {
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
    const { ok, data, error } = await fetchServerOne("market", {
      mode: "pool",
      riseMin: input.riseMin,
      riseMax: input.riseMax,
      marketValueMax: input.marketValueMax,
      limit,
    });
    if (!ok) return `请求失败: ${error}`;
    const pool = Array.isArray(data?.pool) ? data.pool : [];
    return JSON.stringify({ count: pool.length, pool });
  },
};

/**
 * 沪深主板大单突增 — 票池内股票成交额较上一轮基准增量达阈值的异动提醒。
 * hotwave_server 内存缓存上一轮成交额作为基准，首次调用为建立基准（baseline=true，无告警）。
 */
export const financeBigOrderTool: Tool<{
  bigOrderMin?: number;
  limit?: number;
}> = {
  name: "market_big_order",
  description: "获取沪深主板成交额突增异动（大单买入/卖出）：对比上一轮成交额基准，增量达阈值（默认 10 万）的股票列表。首次调用仅建立基准返回空，需间隔后再调才有效；用于捕捉盘中成交额突然放大的主力异动",
  inputSchema: {
    type: "object",
    properties: {
      bigOrderMin: { type: "number", description: "成交额增量阈值（元），默认 100000（10万）" },
      limit: { type: "number", description: "返回条数（默认 20，最多 50）" },
    },
  },
  async execute(input, _ctx) {
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
    const { ok, data, error } = await fetchServerOne("market", {
      mode: "bigorder",
      bigOrderMin: input.bigOrderMin,
      limit,
    });
    if (!ok) return `请求失败: ${error}`;
    const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
    if (data?.baseline) {
      return JSON.stringify({ baseline: true, message: "已建立成交额基准，间隔后再调用获取增量异动", alerts: [] });
    }
    return JSON.stringify({ count: alerts.length, alerts });
  },
};

// ============== 市场综合分析工具 ==============

/**
 * 市场综合分析 — 针对指定标的进行全面分析
 *
 * 调 hotwave_server 行情数据，返回综合市场评估结果。
 * 用于 Agent 在收到监控告警后的自主分析。
 */
export const financeMarketAnalysisTool: Tool<{
  symbol?: string;
  type?: "stock" | "index" | "flow";
  analysis_type?: "quick" | "deep";
}> = {
  name: "market_analysis",
  description: "对指定标的进行市场分析（调用综合行情数据），用于监控告警后的快速分析",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "标的代码，如 sh600519, sz000858, sh000001" },
      type: { type: "string", description: "类型: stock(股票), index(指数), flow(资金流向)" },
      analysis_type: { type: "string", description: "分析深度: quick(快查), deep(深度)" },
    },
  },
  async execute(input, ctx) {
    const symbol = input.symbol ?? "";
    const analysisType = input.analysis_type ?? "quick";
    const type = input.type ?? "stock";

    const result: Record<string, unknown> = {
      analysis_time: new Date().toISOString(),
      symbol,
      type,
    };

    if (type === "index" || (type === "stock" && (symbol.startsWith("sh000") || symbol.startsWith("sz399")))) {
      // 指数分析
      const { ok, data } = await fetchServerOne("quote", { symbol });
      if (ok && data) {
        result.price = data.price ?? 0;
        result.change = data.change ?? 0;
        result.change_pct = data.pctChg ?? 0;
        result.high = data.high ?? 0;
        result.low = data.low ?? 0;
        result.volume = data.volume ?? 0;
      } else {
        result.error = "指数数据获取失败";
      }
    } else if (type === "stock" && symbol) {
      // 个股分析 — 盘口 + 基本面（deep 时附市值/PE/换手）
      const { ok, data } = await fetchServerOne("quote", { symbol });
      if (ok && data) {
        result.name = data.name;
        result.price = data.price ?? 0;
        result.change = data.change ?? 0;
        result.change_pct = data.pctChg ?? 0;
        result.high = data.high ?? 0;
        result.low = data.low ?? 0;
        result.volume = data.volume ?? 0;
        // 振幅 = (high-low)/preClose*100
        result.amplitude = data.preClose && data.high !== undefined && data.low !== undefined
          ? (((data.high - data.low) / data.preClose) * 100)
          : 0;
        result.turnover_rate = data.turnover ?? 0;
      } else {
        result.error = "行情数据获取失败";
      }

      // 深度分析：附市值/PE/换手（行情数据已含这些字段）
      if (analysisType === "deep" && ok && data) {
        result.f10 = {
          open: data.open,
          pre_close: data.preClose,
          total_market_cap: data.marketCap,
          circulating_market_cap: data.flowMarketCap,
          pe_ratio: data.pe,
          turnover_rate: data.turnover,
        };
      }
    } else if (type === "flow") {
      // 资金流向分析
      result.message = "资金流向分析需要综合北向、主力数据";
    }

    // 分析摘要
    if (typeof result.change_pct === "number") {
      const cp = result.change_pct as number;
      if (Math.abs(cp) >= 5) {
        result.signal = Math.abs(cp) >= 9.8 ? "🚨 涨跌停" : `⚠️ 大幅波动 ${cp > 0 ? "上涨" : "下跌"}${Math.abs(cp).toFixed(1)}%`;
        result.suggest_action = "关注异动原因，检查是否有重大消息";
      } else if (Math.abs(cp) >= 3) {
        result.signal = `⚠️ 中度波动 ${cp > 0 ? "上涨" : "下跌"}${Math.abs(cp).toFixed(1)}%`;
        result.suggest_action = "关注是否持续";
      } else {
        result.signal = "正常波动";
      }
    }

    return JSON.stringify(result, null, 2);
  },
};

// ============== 指标计算纯函数 ==============

/** 简单移动平均：返回末尾 n 周期 MA，数据不足返回 null */
export function ma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** RSI(14)：返回末尾 RSI（0-100），数据不足返回 null */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD(12,26,9)：返回末尾 {dif, dea, hist}，数据不足返回 null */
export function macd(
  closes: number[],
  short = 12,
  long = 26,
  signal = 9,
): { dif: number; dea: number; hist: number } | null {
  if (closes.length < long + signal) return null;
  const ema = (vals: number[], n: number): number => {
    const k = 2 / (n + 1);
    let e = vals[0];
    for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
    return e;
  };
  const difSeries: number[] = [];
  for (let i = long - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    difSeries.push(ema(slice, short) - ema(slice, long));
  }
  const dif = difSeries[difSeries.length - 1];
  const dea = ema(difSeries, signal);
  return { dif, dea, hist: 2 * (dif - dea) };
}

// ============== 个股日 K 线 + 技术指标 ==============

export const financeKlineTool: Tool<{ stock_code: string; days?: number }> = {
  name: "finance_kline",
  description:
    "获取个股日K线（前复权）并预计算 MA5/MA20/RSI(14)/MACD 技术指标，供 LLM 评估买卖信号。返回近 N 日（默认 60）OHLCV + 末尾指标 + 金叉标志。",
  inputSchema: {
    type: "object",
    properties: {
      stock_code: { type: "string", description: "股票代码，如 600519 或 600519.SH" },
      days: { type: "number", description: "返回最近 N 日 K线（默认 60，算 MA20/MACD 需 >= 35）" },
    },
    required: ["stock_code"],
  },
  async execute(input, _ctx) {
    const days = input.days ?? 60;
    // K线原始数据由 hotwave_server 提供（同源前复权），返回 {time,open,close,high,low,volume,amount}；
    // 技术指标在本地计算。
    const { ok, data, error } = await fetchServerOne("kline", { symbol: input.stock_code, days });
    if (!ok) return `请求失败: ${error}`;
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return `无 K线数据: ${input.stock_code}`;

    const parsed = rows.map((k: { time: string; open: number; close: number; high: number; low: number; volume: number; amount: number }) => ({
      date: k.time,
      o: k.open,
      c: k.close,
      h: k.high,
      l: k.low,
      v: k.volume,
      amt: k.amount,
    }));
    const closes = parsed.map((k) => k.c);
    const vols = parsed.map((k) => k.v);
    const ma5 = ma(closes, 5);
    const ma20 = ma(closes, 20);
    const rsi14 = rsi(closes, 14);
    const m = macd(closes);
    const latest = parsed[parsed.length - 1];
    // 金叉：昨日 MA5 <= MA20，今日 MA5 > MA20
    const prevMa5 = ma(closes.slice(0, -1), 5);
    const prevMa20 = ma(closes.slice(0, -1), 20);
    const goldenCross =
      ma5 !== null && ma20 !== null && prevMa5 !== null && prevMa20 !== null
        ? prevMa5 <= prevMa20 && ma5 > ma20
        : false;
    const ma5Vol = ma(vols, 5);
    const volBreakout = ma5Vol !== null ? latest.v > ma5Vol : false;
    return JSON.stringify(
      {
        stock: input.stock_code,
        latest,
        ma5,
        ma20,
        rsi14,
        macd: m,
        golden_cross: goldenCross,
        vol_today: latest.v,
        ma5_vol: ma5Vol,
        vol_breakout: volBreakout, // 当日量 > 5 日均量
        klines: parsed,
      },
      null,
      2,
    );
  },
};

// ============== 导出 ==============

export const financeTools: Tool[] = [
  financeKlineTool,
  finance10jqkaHotTool,
  financeEastmoneyHotTool,
  financeF10DataTool,
  financeIndexDataTool,
  financePankouDataTool,
  financeMarketAnomalyTool,
  financeBigOrderTool,
  financeMarketAnalysisTool,
];
