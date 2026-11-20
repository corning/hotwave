/**
 * 交易记录落库（TradeStore）
 *
 * 调用 hotwave_server REST API 持久化交易记录，供 APP 记录/分析页查询。
 * 用 hotwave 绑定凭证（X-Binding-Id/X-Binding-Secret）鉴权——
 * 该 hotwave 实例绑定哪个用户，交易就归属哪个用户。凭证由用户在 APP
 * 生成绑定后配置到 hotwave .env 的 TRADE_BINDING_ID / TRADE_BINDING_SECRET。
 *
 * 落库失败不再静默：recordTrade 返回 { ok, row?, error? }，由 TradeRouter 决定
 * 是否把告警透传给 Agent（成交已发生不回滚，仅告警"记录未落库"）。
 */

import type { Usage } from "@mariozechner/pi-ai";

/** heartbeat / alert / schedule 决策记录的可选元数据 */
export interface HeartbeatReportOpts {
  /** 决策来源（默认 heartbeat）；error = 心跳执行失败留痕 */
  source?: "heartbeat" | "alert" | "schedule" | "error";
  /** alert 关联标的（heartbeat/schedule 为空） */
  symbol?: string;
  /** LLM token 用量 */
  usage?: Usage;
  /** 触发原因（含并发等待记录） */
  triggerReason?: string;
}

export interface TradeRecordInput {
  mode: 'paper' | 'live';
  stockCode: string;
  stockName?: string;
  bsType: 'buy' | 'sell';
  price: number;
  amount: number;
  cost: number;
  total: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  entrustNo: string;
  strategyTag?: string;
  pnl?: number;
  note?: string;
}

export interface ExecutionLogInput {
  mode: 'paper' | 'live';
  title: string;
  description?: string;
  status?: 'success' | 'failure' | 'pending';
  logType?: 'trade' | 'risk_control' | 'system' | 'alert';
  tradeId?: number;
  strategyTag?: string;
}

export interface ExecutionLogRow {
  id: number;
  user_id: number;
  mode: string;
  title: string;
  description: string;
  status: string;
  log_type: string;
  trade_id: number | null;
  strategy_tag: string;
  created_at: string;
}

export interface TradeRecordRow {
  id: number;
  user_id: number;
  mode: string;
  stock_code: string;
  stock_name: string;
  bs_type: string;
  price: number;
  amount: number;
  cost: number;
  total: number;
  status: string;
  entrust_no: string;
  strategy_tag: string;
  pnl: number;
  note: string;
  created_at: string;
}

export interface RecordResult {
  ok: boolean;
  row?: TradeRecordRow;
  /** 未配置/HTTP错误/鉴权失败的简短原因，供 Agent 告警 */
  error?: string;
}

const API_BASE = process.env.TRADE_API_BASE || 'http://localhost:8000/api';
const BINDING_ID = process.env.TRADE_BINDING_ID || '';
const BINDING_SECRET = process.env.TRADE_BINDING_SECRET || '';

async function request(path: string, init?: RequestInit): Promise<any> {
  if (!BINDING_ID || !BINDING_SECRET) {
    return { __unconfigured: true };
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Binding-Id': BINDING_ID,
      'X-Binding-Secret': BINDING_SECRET,
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { __httpError: res.status, __body: txt };
  }
  return res.json();
}

export async function recordTrade(t: TradeRecordInput): Promise<RecordResult> {
  const data: any = await request('/trades', {
    method: 'POST',
    body: JSON.stringify(t),
  });
  if (data?.__unconfigured) {
    return { ok: false, error: 'TRADE_BINDING_ID/TRADE_BINDING_SECRET 未配置，交易记录未落库' };
  }
  if (data?.__httpError) {
    const hint = data.__httpError === 401 ? '（绑定凭证无效或已吊销，请在 APP 重新生成绑定）' : '';
    return { ok: false, error: `落库 HTTP ${data.__httpError} ${hint}` };
  }
  if (data?.ok && data.payload) {
    return { ok: true, row: data.payload as TradeRecordRow };
  }
  return { ok: false, error: data?.error ? `落库失败：${data.error}` : '落库失败（未知原因）' };
}

/**
 * 直写 heartbeat 简报到 hotwave_server 独立表（heartbeat_reports）。
 *
 * heartbeat 简报已彻底移出 chat 体系：hotwave 不再 broadcast("chat", _heartbeat_)，
 * message_end 时直接 HTTP 回写本端点落 heartbeat_reports，APP 简报中心查询该表。
 * 按 runId 去重（INSERT OR IGNORE）。
 * best-effort：未配置凭证或 HTTP 失败仅记日志，不抛错、不阻塞 heartbeat 主流程。
 * 返回 true 表示新建入库（false = 已存在/失败/未配置）。
 */
export async function recordHeartbeatReport(
  runId: string,
  text: string,
  opts?: HeartbeatReportOpts,
): Promise<boolean> {
  if (!runId || !text.trim()) return false;
  if (!BINDING_ID || !BINDING_SECRET) {
    return false; // 未配置 binding，跳过
  }
  try {
    const data: any = await request('/heartbeat-reports', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        text,
        source: opts?.source ?? "heartbeat",
        symbol: opts?.symbol,
        inputTokens: opts?.usage?.input,
        outputTokens: opts?.usage?.output,
        totalTokens: opts?.usage?.totalTokens,
        cost: opts?.usage?.cost?.total,
        triggerReason: opts?.triggerReason,
      }),
    });
    if (data?.__httpError) {
      console.warn(`[TradeStore] heartbeat 兜底回写 HTTP ${data.__httpError}: ${data.__body || ''}`);
      return false;
    }
    return Boolean(data?.ok && data?.payload?.inserted);
  } catch (err) {
    console.warn(`[TradeStore] heartbeat 兜底回写异常:`, (err as Error).message);
    return false;
  }
}

/** 拉取指定 mode 的全部交易记录（供 PaperTrader 重启重放） */
export async function fetchTrades(mode: 'paper' | 'live'): Promise<TradeRecordRow[]> {
  if (!BINDING_ID || !BINDING_SECRET) return [];
  const all: TradeRecordRow[] = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const data: any = await request(`/trades?mode=${mode}&page=${page}&pageSize=${pageSize}`);
    if (data?.__unconfigured || data?.__httpError || !data?.ok) break;
    const rows = data.payload?.rows as TradeRecordRow[] | undefined;
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
    page++;
  }
  // 按时间正序重放
  return all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export async function recordExecutionLog(input: ExecutionLogInput): Promise<{ ok: boolean; row?: ExecutionLogRow; error?: string }> {
  const data: any = await request('/execution-logs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (data?.__unconfigured) {
    return { ok: false, error: 'TRADE_BINDING_ID/TRADE_BINDING_SECRET 未配置，执行日志未落库' };
  }
  if (data?.__httpError) {
    return { ok: false, error: `执行日志落库 HTTP ${data.__httpError}` };
  }
  if (data?.ok && data.payload) {
    return { ok: true, row: data.payload as ExecutionLogRow };
  }
  return { ok: false, error: data?.error ? `执行日志落库失败：${data.error}` : '执行日志落库失败（未知原因）' };
}

export function isConfigured(): boolean {
  return !!BINDING_ID && !!BINDING_SECRET;
}

