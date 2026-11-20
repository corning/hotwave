// server_app 数据端点客户端（hotwave finance 工具统一数据源）。
// 每类数据一个独立路径，统一前缀 /api/hotwave/（kline / hot / f10 / quote / trade-days / stocks）。
// 端点不做用户验证（行情数据公开），hotwave 直接 fetch，无需凭证。
// server_app 不可用 → 返回错误标记，工具报"数据服务不可用"，不降级直连外部。

const API_BASE = process.env.TRADE_API_BASE || 'http://localhost:8000/api';

export type FetchOneResult = {
  ok: boolean;
  data?: any;
  error?: string;
};

/** 调 server_app 独立数据端点，POST /api/hotwave/{path}，body 为业务参数 */
export async function fetchServerOne(path: string, body: Record<string, unknown> = {}): Promise<FetchOneResult> {
  try {
    const res = await fetch(`${API_BASE}/hotwave/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `server_app HTTP ${res.status}` };
    const json: any = await res.json();
    if (json?.ok) return { ok: true, data: json.data };
    return { ok: false, error: json?.error || 'server_app 返回异常' };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { ok: false, error: `server_app 数据服务不可用: ${e.cause?.message || e.message}` };
  }
}

/** 调 server_app 独立数据端点，GET /api/hotwave/{path}?query（供静态公共数据：trade-days / stocks / stocks/search） */
export async function fetchServerOneGet(
  path: string,
  query: Record<string, string | number> = {},
): Promise<FetchOneResult> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
  ).toString();
  try {
    const res = await fetch(`${API_BASE}/hotwave/${path}${qs ? `?${qs}` : ''}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `server_app HTTP ${res.status}` };
    const json: any = await res.json();
    if (json?.ok) return { ok: true, data: json.data };
    return { ok: false, error: json?.error || 'server_app 返回异常' };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { ok: false, error: `server_app 数据服务不可用: ${e.cause?.message || e.message}` };
  }
}

/** 调 server_app 下载二进制 zip（技能市场安装包），30s 超时；失败抛错 */
export async function fetchServerZip(path: string): Promise<Uint8Array> {
  const res = await fetch(`${API_BASE}/${path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`server_app HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
