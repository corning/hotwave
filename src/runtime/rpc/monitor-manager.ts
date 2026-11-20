/**
 * MonitorManager — 监控订阅管理
 *
 * 管理监控标的的订阅/取消订阅，处理告警冷却和去重，
 * 供 monitor.* RPC 处理器和 Python Monitor Engine 使用。
 */

import crypto from "node:crypto";
import type { MonitorItem, MonitorAlert, MonitorStatus, AlertRule } from "./protocol.js";

// ============== 类型 ==============

export type AlertCallback = (alert: MonitorAlert) => void;
export type StatusChangeCallback = (status: Partial<MonitorStatus & { itemsList: MonitorItem[] }>) => void;

export type MonitorManagerOptions = {
  /** 同一标的告警冷却（毫秒），默认 60 秒 */
  alertCooldownMs?: number;
  /** 告警回调 */
  onAlert?: AlertCallback;
  /** 状态变更回调 */
  onStatusChange?: StatusChangeCallback;
};

// ============== MonitorManager ==============

export class MonitorManager {
  private items = new Map<string, MonitorItem>();
  private lastAlertTime = new Map<string, number>();
  private alertHistory: MonitorAlert[] = [];
  private alertCooldownMs: number;
  private startedAt = Date.now();
  private _running = false;
  private _tradingSession = "idle";
  // public：允许 server-app-client 包装（alert/statusChange 同时上行 server_app）
  onAlert?: AlertCallback;
  onStatusChange?: StatusChangeCallback;

  constructor(opts: MonitorManagerOptions = {}) {
    this.alertCooldownMs = opts.alertCooldownMs ?? 60_000;
    this.onAlert = opts.onAlert;
    this.onStatusChange = opts.onStatusChange;
  }

  // ============== 订阅管理 ==============

  /** 添加或更新监控标的 */
  subscribe(items: MonitorItem[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    for (const item of items) {
      if (this.items.has(item.id)) {
        updated++;
      } else {
        added++;
      }
      this.items.set(item.id, item);
    }
    this.notifyStatusChange();
    return { added, updated };
  }

  /** 取消监控标的 */
  unsubscribe(itemIds?: string[]): { removed: number } {
    if (!itemIds || itemIds.length === 0) {
      const count = this.items.size;
      this.items.clear();
      this.notifyStatusChange();
      return { removed: count };
    }
    let removed = 0;
    for (const id of itemIds) {
      if (this.items.delete(id)) {
        this.lastAlertTime.delete(id);
        removed++;
      }
    }
    this.notifyStatusChange();
    return { removed };
  }

  /** 获取所有监控标的（指数优先排序） */
  getItems(): MonitorItem[] {
    const all = Array.from(this.items.values());
    const typeOrder: Record<string, number> = { index: 0, stock: 1, flow: 2, linked: 3 };
    all.sort((a, b) => {
      const oa = typeOrder[a.type] ?? 9;
      const ob = typeOrder[b.type] ?? 9;
      return oa - ob || a.symbol.localeCompare(b.symbol);
    });
    return all;
  }

  /** 获取监控标的数量 */
  getItemCount(): number {
    return this.items.size;
  }

  // ============== 告警处理 ==============

  /** 触发告警（由 Python Monitor Engine 或内部检测调用） */
  raiseAlert(alert: Omit<MonitorAlert, "id" | "timestamp">): MonitorAlert | null {
    const itemId = alert.item.id;

    // 冷却检查
    const lastTime = this.lastAlertTime.get(itemId) ?? 0;
    const now = Date.now();
    if (now - lastTime < this.alertCooldownMs) {
      return null; // 冷却中，丢弃
    }

    const fullAlert: MonitorAlert = {
      ...alert,
      id: `alert-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: now,
    };

    this.lastAlertTime.set(itemId, now);
    this.alertHistory.push(fullAlert);

    // 限制告警历史数量
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-500);
    }

    // 回调
    this.onAlert?.(fullAlert);

    return fullAlert;
  }

  /** 获取最近的告警历史 */
  getAlertHistory(limit = 50): MonitorAlert[] {
    return this.alertHistory.slice(-limit);
  }

  // ============== 引擎状态 ==============

  /** 设置监控引擎运行状态 */
  setRunning(running: boolean): void {
    this._running = running;
    this.notifyStatusChange();
  }

  /** 设置交易时段 */
  setTradingSession(session: string): void {
    this._tradingSession = session;
    this.notifyStatusChange();
  }

  /** 获取当前状态 */
  getStatus(): MonitorStatus {
    return {
      running: this._running,
      items: this.items.size,
      alertsToday: this.alertHistory.length,
      uptimeMs: Date.now() - this.startedAt,
      tradingSession: this._tradingSession,
    };
  }

  /** 获取当前状态及其监控标的列表（用于广播） */
  getStatusWithItems(): MonitorStatus & { itemsList: MonitorItem[] } {
    return {
      ...this.getStatus(),
      itemsList: this.getItems(),
    };
  }

  // ============== 规则检查 ==============

  /**
   * 检查数据是否触发任何规则
   * 返回匹配的规则列表
   */
  checkRules(symbol: string, metrics: Record<string, number>): AlertRule[] {
    const triggered: AlertRule[] = [];
    for (const item of this.items.values()) {
      if (item.symbol !== symbol || !item.thresholds) continue;
      for (const rule of item.thresholds) {
        const value = metrics[rule.metric];
        if (value === undefined) continue;
        if (this.evaluateRule(value, rule)) {
          triggered.push(rule);
        }
      }
    }
    return triggered;
  }

  private evaluateRule(value: number, rule: AlertRule): boolean {
    switch (rule.operator) {
      case "gt": return value > rule.value;
      case "lt": return value < rule.value;
      case "gte": return value >= rule.value;
      case "lte": return value <= rule.value;
      case "cross": return Math.abs(value - rule.value) < 0.01; // 近似穿越
      default: return false;
    }
  }

  // ============== 内部 ==============

  private notifyStatusChange(): void {
    this.onStatusChange?.(this.getStatusWithItems());
  }

  /** 重置管理器 */
  reset(): void {
    this.items.clear();
    this.lastAlertTime.clear();
    this.alertHistory = [];
    this._running = false;
    this._tradingSession = "idle";
    this.startedAt = Date.now();
  }
}
