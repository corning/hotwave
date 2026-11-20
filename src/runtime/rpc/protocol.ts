/**
 * Gateway 协议帧定义
 *
 * 设计要点:
 * - RequestFrame (req)  — 客户端→服务端的 RPC 调用
 * - ResponseFrame (res) — 服务端→客户端的 RPC 响应（通过 id 关联）
 * - EventFrame (event)  — 服务端→客户端的推送事件（seq 单调递增）
 */

import crypto from "node:crypto";

// ============== 协议版本 ==============

export const PROTOCOL_VERSION = 1;

// ============== 帧类型 ==============

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq: number;
};

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

// ============== 错误 ==============

export type ErrorShape = { code: string; message: string };

export const ErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export function errorShape(code: string, message: string): ErrorShape {
  return { code, message };
}

// ============== 握手响应 ==============

export type HelloOk = {
  protocol: number;
  methods: string[];
  events: string[];
  policy: { tickIntervalMs: number; maxPayloadBytes: number };
};

// ============== 帧验证（类型守卫） ==============

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isRequestFrame(f: unknown): f is RequestFrame {
  return isObject(f) && f.type === "req" && typeof f.id === "string" && typeof f.method === "string";
}

export function isResponseFrame(f: unknown): f is ResponseFrame {
  return isObject(f) && f.type === "res" && typeof f.id === "string" && typeof f.ok === "boolean";
}

export function isEventFrame(f: unknown): f is EventFrame {
  return isObject(f) && f.type === "event" && typeof f.event === "string";
}

// ============== 常量 ==============

export const TICK_INTERVAL_MS = 30_000;
export const MAX_PAYLOAD_BYTES = 512 * 1024;
export const MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 60_000;

export const GATEWAY_METHODS = [
  "connect", "chat.send", "chat.history",
  "chat.abort",
  "sessions.list", "sessions.reset", "health",
  "agent.state",
  "approval.list", "approval.decide",
  "monitor.subscribe", "monitor.unsubscribe",
  "monitor.status", "monitor.instruct",
  "monitor.search_stocks",
  "trader.balance",
  "trader.liquidate",
  "trader.status",
  "notifications.register", "notifications.unregister",
  "notifications.config",
] as const;

export const GATEWAY_EVENTS = [
  "connect.challenge", "tick", "agent", "chat", "shutdown",
  "monitor.alert", "monitor.tick", "monitor.status_change",
  "approval.request", "approval.resolved",
] as const;

export function newId(): string {
  return crypto.randomUUID();
}

// ============== 监控系统类型定义 ==============

/** 监控标的 */
export type MonitorItem = {
  id: string;
  type: "stock" | "index" | "flow" | "linked";
  symbol: string;
  /** 股票名称（hotwave_server 全市场列表提供），可选（老 item 可能无此字段） */
  name?: string;
  interval: number;
  thresholds?: AlertRule[];
  linked?: LinkedItem[];
};

/** 联动关联 */
export type LinkedItem = {
  type: "stock" | "index";
  symbol: string;
  relation: "correlated" | "inverse" | "leading";
  threshold?: number;
};

/** 告警规则 */
export type AlertRule = {
  metric: "price_change_pct" | "volume_ratio" | "turnover_rate" |
          "amplitude" | "capital_flow" | "technical_break" | "limit_up_down";
  operator: "gt" | "lt" | "gte" | "lte" | "cross";
  value: number;
  duration?: number;
  level: "info" | "warning" | "critical";
  message?: string;
};

/** 告警事件载荷 */
export type MonitorAlert = {
  id: string;
  level: "info" | "warning" | "critical";
  item: { id: string; symbol: string; type: string; name?: string };
  metrics: Record<string, number>;
  linked?: Array<{ symbol: string; change_pct: number }>;
  message?: string;
  timestamp: number;
};

/** 监控引擎状态 */
export type MonitorStatus = {
  running: boolean;
  items: number;
  alertsToday: number;
  uptimeMs: number;
  tradingSession: string;
};

/** 默认监控指数列表（与 Python monitor_engine/config.py 的 MONITOR_INDEX_LIST 对齐） */
export const DEFAULT_MONITOR_INDICES: MonitorItem[] = [
  { id: "index-sh000001", type: "index", symbol: "sh000001", name: "上证指数", interval: 3 },
  { id: "index-sz399001", type: "index", symbol: "sz399001", name: "深证成指", interval: 3 },
  { id: "index-sz399006", type: "index", symbol: "sz399006", name: "创业板指", interval: 3 },
  { id: "index-sh000688", type: "index", symbol: "sh000688", name: "科创50", interval: 3 },
];
