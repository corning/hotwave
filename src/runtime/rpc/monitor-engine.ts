/**
 * 内置监控引擎（替代原 Python 瘦客户端 hotwave/monitor_client）
 *
 * 数据通路（全部进程内，零端口、零额外进程）：
 *   监控清单 ← MonitorManager.getItems()           （不再 GET /monitor/status）
 *   行情    ← server_app /api/hotwave/quote        （与 9 个 finance 工具同源，见 tools/server-app-data.ts）
 *             └ server_app 不可用时回落腾讯 qt.gtimg.cn（告警链路不因后端重启而中断）
 *   告警    → MonitorManager.raiseAlert()          （冷却/去重/广播/IM 路由同一条链路，不再 POST /monitor/ingest）
 *   时段    → 复用 monitor.instruct handler        （IM 通知 + 关键时点触发心跳，与旧客户端语义一致）
 *
 * 随网关启动，随 gw.close() 停止；状态经 /monitor/status 的 engine 字段暴露。
 */

import { fetchServerOne } from '../../tools/server-app-data.js';
import type { MonitorAlert, MonitorItem } from './protocol.js';
import { currentTradingSession } from './trading-session.js';

export type Quote = {
  symbol: string;
  name?: string;
  price: number;
  changePct: number;
  /** 成交量（手），与腾讯 parts[6] / server_app quote.volume 一致 */
  volume: number;
};

export type QuoteSource = 'server_app' | 'tencent' | 'none';
export type QuoteResult = { quotes: Map<string, Quote>; source: QuoteSource };

export type MonitorEngineStatus = {
  enabled: boolean;
  intervalMs: number;
  polls: number;
  skipped: number;
  alerts: number;
  lastPollAt: number | null;
  lastPollMs: number;
  lastQuoteCount: number;
  lastSource: QuoteSource;
  lastError: string | null;
};

export type MonitorEngineDeps = {
  enabled: boolean;
  /** 轮询间隔，默认 5000ms（MONITOR_INTERVAL 秒级优先） */
  intervalMs?: number;
  /** 异动阈值（涨跌幅绝对值 %），默认 3.0（涨跌停另有 9.8 的硬阈值） */
  pricePct?: number;
  /** 放量倍数（本轮量 / 上轮量），默认 2.0 */
  volumeRatio?: number;
  getItems: () => MonitorItem[];
  raiseAlert: (alert: Omit<MonitorAlert, 'id' | 'timestamp'>) => MonitorAlert | null;
  onSessionChange?: (from: string, to: string) => void;
  session?: () => string;
  fetchQuotes?: (symbols: string[]) => Promise<QuoteResult>;
  log?: (msg: string) => void;
};

export type MonitorEngine = {
  status: () => MonitorEngineStatus;
  /** 立即跑一轮（自测/排障用） */
  pollNow: () => Promise<void>;
  stop: () => void;
};

const LIMIT_PCT = 9.8;

/** 与腾讯/东财一致的行情代码：600519 → sh600519，000001 → sz000001 */
export function tencentSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  if (s.startsWith('sh') || s.startsWith('sz') || s.startsWith('bj')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) return s;
  return (digits.startsWith('6') || digits.startsWith('9') ? 'sh' : 'sz') + digits;
}

function pureCode(symbol: string): string {
  return symbol.replace(/\D/g, '');
}

function pickQuote(quotes: Map<string, Quote>, symbol: string): Quote | undefined {
  return (
    quotes.get(symbol) ??
    quotes.get(tencentSymbol(symbol)) ??
    quotes.get(pureCode(symbol)) ??
    undefined
  );
}

// ---------------- 行情源 ----------------

/** 主数据源：server_app /api/hotwave/quote（POST，内部有 3s 行情缓存） */
async function quotesFromServerApp(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const results = await Promise.allSettled(symbols.map((symbol) => fetchServerOne('quote', { symbol })));
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value.ok || !r.value.data) return;
    const d = r.value.data as any;
    const price = Number(d?.price);
    if (!Number.isFinite(price) || price <= 0) return;
    const quote: Quote = {
      symbol: String(d?.symbol ?? tencentSymbol(symbols[i])),
      name: d?.name ? String(d.name) : undefined,
      price,
      changePct: Number.isFinite(Number(d?.pctChg)) ? Number(d.pctChg) : 0,
      volume: Number.isFinite(Number(d?.volume)) ? Number(d.volume) : 0,
    };
    out.set(quote.symbol, quote);
    out.set(symbols[i], quote);
    out.set(pureCode(symbols[i]), quote);
  });
  return out;
}

/** 兜底数据源：腾讯行情（GBK），server_app 不在时仍能告警 */
async function quotesFromTencent(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!symbols.length) return out;
  const qs = symbols.map(tencentSymbol).join(',');
  const res = await fetch('https://qt.gtimg.cn/q=' + qs, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error('tencent HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('gbk').decode(buf);
  } catch {
    text = new TextDecoder('utf-8').decode(buf);
  }
  for (const line of text.split(';')) {
    if (!line.includes('=') || !line.includes('"')) continue;
    const head = line.split('=', 1)[0];
    const fields = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).split('~');
    if (fields.length < 33) continue;
    const code = head.replace(/^v_/, '').trim();
    const price = parseFloat(fields[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const quote: Quote = {
      symbol: code,
      name: fields[1] || code,
      price,
      changePct: Number.parseFloat(fields[32]) || 0,
      volume: Number.parseFloat(fields[6]) || 0,
    };
    out.set(code, quote);
    out.set(pureCode(code), quote);
  }
  return out;
}

/**
 * 取行情：MONITOR_QUOTE_SOURCE=auto（默认）→ 先 server_app，失败/空结果再回落腾讯；
 * =server_app 只用后端；=tencent 直连腾讯（后端维护时可临时用）。
 */
export async function fetchQuotes(symbols: string[]): Promise<QuoteResult> {
  if (!symbols.length) return { quotes: new Map(), source: 'none' };
  const mode = (process.env.MONITOR_QUOTE_SOURCE || 'auto').toLowerCase();
  if (mode === 'tencent') {
    return { quotes: await quotesFromTencent(symbols), source: 'tencent' };
  }
  try {
    const quotes = await quotesFromServerApp(symbols);
    if (quotes.size > 0) return { quotes, source: 'server_app' };
  } catch {
    /* 回落腾讯 */
  }
  if (mode === 'server_app') return { quotes: new Map(), source: 'none' };
  return { quotes: await quotesFromTencent(symbols), source: 'tencent' };
}

// ---------------- 检测 ----------------

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function detect(
  item: MonitorItem,
  quote: Quote,
  prevVolume: Map<string, number>,
  pricePct: number,
  volumeRatio: number,
  alerts: Omit<MonitorAlert, 'id' | 'timestamp'>[],
): void {
  const symbol = item.symbol;
  const name = item.name || quote.name || symbol;
  const base = { id: item.id, symbol, type: item.type, name };
  const metrics: Record<string, number> = { price: quote.price, changePct: quote.changePct };
  const pct = quote.changePct;

  if (Math.abs(pct) >= LIMIT_PCT) {
    alerts.push({
      level: 'critical',
      item: base,
      metrics,
      message: (pct > 0 ? '涨停 ' : '跌停 ') + name + ' ' + symbol + ' ' + fmt(quote.price),
    });
  } else if (Math.abs(pct) >= pricePct) {
    alerts.push({
      level: 'warning',
      item: base,
      metrics,
      message: '异动 ' + name + ' ' + symbol + ' ' + (pct >= 0 ? '+' : '') + fmt(pct) + '% 现价 ' + fmt(quote.price),
    });
  }

  const prev = prevVolume.get(symbol);
  if (prev && prev > 0 && quote.volume > prev * volumeRatio) {
    alerts.push({
      level: 'warning',
      item: base,
      metrics: { ...metrics, volume: quote.volume, prevVolume: prev, ratio: quote.volume / prev },
      message:
        '放量 ' + name + ' ' + symbol + ' 本轮量 ' + fmt(quote.volume, 0) +
        ' 达上轮 ' + fmt(prev, 0) + ' 的 ' + fmt(quote.volume / prev, 1) + ' 倍',
    });
  }
  prevVolume.set(symbol, quote.volume);
}

// ---------------- 引擎 ----------------

export function startMonitorEngine(deps: MonitorEngineDeps): MonitorEngine {
  const intervalMs = deps.intervalMs ?? 5000;
  const pricePct = deps.pricePct ?? 3.0;
  const volumeRatio = deps.volumeRatio ?? 2.0;
  const sessionOf = deps.session ?? (() => currentTradingSession());
  const fetchQuoteFn = deps.fetchQuotes ?? fetchQuotes;
  const log = deps.log ?? ((m: string) => console.log(m));

  const prevVolume = new Map<string, number>();
  let lastSession = sessionOf();
  let running = false;
  let stopped = false;

  const status: MonitorEngineStatus = {
    enabled: !!deps.enabled,
    intervalMs,
    polls: 0,
    skipped: 0,
    alerts: 0,
    lastPollAt: null,
    lastPollMs: 0,
    lastQuoteCount: 0,
    lastSource: 'none',
    lastError: null,
  };

  const poll = async (): Promise<void> => {
    if (stopped || !status.enabled) return;
    if (running) { status.skipped++; return; }
    running = true;
    const t0 = Date.now();
    status.lastPollAt = t0;
    try {
      const items = deps.getItems().filter((i) => i.symbol);
      const symbols = Array.from(new Set(items.map((i) => i.symbol)));
      if (symbols.length) {
        const { quotes, source } = await fetchQuoteFn(symbols);
        // map 里同一标的存了多种 key（原文/规范化/纯代码），计数按去重后的 Quote 数
        status.lastQuoteCount = new Set(quotes.values()).size;
        status.lastSource = source;
        const pending: Omit<MonitorAlert, 'id' | 'timestamp'>[] = [];
        for (const item of items) {
          const q = pickQuote(quotes, item.symbol);
          if (!q) continue;
          detect(item, q, prevVolume, pricePct, volumeRatio, pending);
        }
        for (const alert of pending) {
          const raised = deps.raiseAlert(alert);
          if (raised) status.alerts++;
        }
        status.lastError = null;
      }
    } catch (e) {
      status.lastError = (e as Error).message;
      log('[monitor] 取行情失败: ' + status.lastError);
    } finally {
      status.polls++;
      status.lastPollMs = Date.now() - t0;
      running = false;

      // 交易时段变化（与旧瘦客户端一致：只在上报变化，首轮只记录不报）
      const now = sessionOf();
      if (now !== lastSession) {
        const from = lastSession;
        lastSession = now;
        try {
          deps.onSessionChange?.(from, now);
        } catch (e) {
          log('[monitor] session_change 处理失败: ' + (e as Error).message);
        }
      }
    }
  };

  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  if (status.enabled) {
    void poll();
    log('[monitor] 内置引擎已启动：每 ' + intervalMs + 'ms 轮询（行情源 ' +
      (process.env.MONITOR_QUOTE_SOURCE || 'auto') + '）');
  } else {
    log('[monitor] 内置引擎未启用（MONITOR_ENABLED=false）');
  }

  return {
    status: () => ({ ...status }),
    pollNow: poll,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
