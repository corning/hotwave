/**
 * NotificationRouter — 通知路由器
 *
 * 将系统消息（心跳报告、监控告警、时段转换）路由到各 IM 渠道。
 *
 * 核心设计:
 * - 系统消息复用 chat 管道：将系统消息转换为渠道 session key 的 chat 事件，
 *   渠道的现有 sessionKey 过滤逻辑自然匹配，无需改动渠道代码
 * - 单次 LLM 调用 + 多渠道 fan-out：Heartbeat 只运行一次 Agent，
 *   结果通过 NotificationRouter 分发到多个渠道
 * - 每个渠道可独立配置接收哪些类型的通知、哪些时段的报告、哪些级别的告警
 */

import type { BroadcastFn } from "./handlers.js";
import type { MonitorAlert } from "./protocol.js";

// ============== 类型 ==============

/** 交易时段 */
export type TradingPhase = "pre_open" | "morning" | "midday" | "afternoon" | "post_market";

/** 告警级别 */
export type AlertLevel = "info" | "warning" | "critical";

/** 渠道通知配置 */
export interface ChannelNotificationConfig {
  /** 渠道 ID: telegram | feishu | dingtalk | wechat */
  channelId: string;

  /** 心跳/定时报告配置 */
  heartbeat: {
    enabled: boolean;
    /** 该渠道接收哪些时段的报告 */
    phases: TradingPhase[];
    /** 推送目标 (chatId / openId / userId / wxid) */
    targets: string[];
  };

  /** 监控告警配置 */
  alerts: {
    enabled: boolean;
    /** 只推送这些级别的告警 */
    levels: AlertLevel[];
    /** 只推送这些类型的告警 (price/volume/capital/index/technical/linked) */
    types?: string[];
    /** 推送目标 */
    targets: string[];
  };

  /** 时段转换通知配置 */
  sessionChange: {
    enabled: boolean;
    /** 推送目标 */
    targets: string[];
  };

}

/** 路由结果：一次路由匹配到的所有目标 */
export interface RouteTarget {
  channelId: string;
  sessionKey: string;
  identifier: string;
}

/** 通知路由器选项 */
export interface NotificationRouterOptions {
  /** 广播函数 */
  broadcast: BroadcastFn;
  /** 配置文件路径（可选，默认不持久化） */
  /** 初始配置（可选；渠道启动时会用 notifications.register 自注册） */
  configs?: ChannelNotificationConfig[];
}

// ============== 交易时段映射 ==============

/**
 * 将当前时间 + Monitor Engine 的 session 状态映射为交易阶段
 *
 * session 值 (from engine): pre_open / morning / afternoon / block_trade / idle
 * TradingPhase (配置用):     pre_open / morning / midday / afternoon / post_market
 */
export function sessionToPhase(session: string, hour: number): TradingPhase | null {
  switch (session) {
    case "pre_open": return "pre_open";
    case "morning": return "morning";
    case "afternoon": return "afternoon";
    case "block_trade": return "post_market";
    case "idle":
      // idle 需要区分午间休市 vs 盘后
      if (hour >= 11 && hour < 13) return "midday";
      if (hour >= 15) return "post_market";
      return null; // 非交易时段的 idle（如夜间）
    default: return null;
  }
}

/** TradingPhase → 中文标签 */
export function phaseLabel(phase: TradingPhase): string {
  switch (phase) {
    case "pre_open": return "盘前";
    case "morning": return "上午盘中";
    case "midday": return "午间休市";
    case "afternoon": return "下午盘中";
    case "post_market": return "盘后";
  }
}

// ============== NotificationRouter ==============

export class NotificationRouter {
  private configs = new Map<string, ChannelNotificationConfig>();
  private broadcast: BroadcastFn;

  // 当前交易时段（由 session_change 更新）
  private currentSession = "idle";

  constructor(opts: NotificationRouterOptions) {
    this.broadcast = opts.broadcast;
    for (const c of opts.configs ?? []) this.configs.set(c.channelId, c);
  }

  // ============== 配置管理 ==============

  /** 注册或更新渠道通知配置 */
  register(config: ChannelNotificationConfig): void {
    this.configs.set(config.channelId, config);
  }

  /** 注销渠道通知配置 */
  unregister(channelId: string): void {
    this.configs.delete(channelId);
  }

  /** 获取所有渠道配置 */
  getAllConfigs(): ChannelNotificationConfig[] {
    return Array.from(this.configs.values());
  }

  /** 获取指定渠道配置 */
  getConfig(channelId: string): ChannelNotificationConfig | undefined {
    return this.configs.get(channelId);
  }

  // ============== 心跳报告路由 ==============

  /**
   * 路由心跳报告到匹配的渠道
   *
   * @param text - 心跳报告完整文本
   * @param session - 当前交易时段 (from engine)
   */
  routeHeartbeat(text: string, session?: string): void {
    const phase = sessionToPhase(session ?? this.currentSession, new Date().getHours());
    if (!phase) return; // 非交易时段不路由

    for (const config of this.configs.values()) {
      if (!config.heartbeat.enabled) continue;
      if (!config.heartbeat.phases.includes(phase)) continue;
      if (config.heartbeat.targets.length === 0) continue;

      // 构造带时段标签的前缀
      const labeledText = `📊 【${phaseLabel(phase)}定时报告】\n\n${text}`;

      for (const target of config.heartbeat.targets) {
        const sessionKey = `${config.channelId}:${target}`;
        this.broadcast("chat", {
          sessionKey,
          state: "final",
          text: labeledText,
          source: "heartbeat",
          phase,
        }, { dropIfSlow: true });
      }
    }
  }

  // ============== 告警路由 ==============

  /**
   * 路由监控告警到匹配的渠道
   */
  routeAlert(alert: MonitorAlert): void {
    for (const config of this.configs.values()) {
      if (!config.alerts.enabled) continue;
      if (!config.alerts.levels.includes(alert.level)) continue;

      // 类型过滤（如果有配置）
      if (config.alerts.types && config.alerts.types.length > 0) {
        const alertType = this.inferAlertType(alert);
        if (!config.alerts.types.includes(alertType)) continue;
      }

      if (config.alerts.targets.length === 0) continue;

      // 构造告警文本
      const alertEmoji = alert.level === "critical" ? "🔴" : alert.level === "warning" ? "🟡" : "ℹ️";
      const alertText = `${alertEmoji} 【${alert.level === "critical" ? "紧急" : alert.level === "warning" ? "警告" : "提示"}告警】
标的: ${alert.item.symbol}
${alert.message ?? ""}
${Object.entries(alert.metrics).map(([k, v]) => `${k}: ${v}`).join(" | ")}
时间: ${new Date(alert.timestamp).toLocaleString("zh-CN", { hour12: false })}`;

      for (const target of config.alerts.targets) {
        const sessionKey = `${config.channelId}:${target}`;
        this.broadcast("chat", {
          sessionKey,
          state: "final",
          text: alertText,
          source: "alert",
          level: alert.level,
        });
      }
    }
  }

  // ============== 时段转换路由 ==============

  /**
   * 路由时段转换通知到匹配的渠道
   */
  routeSessionChange(from: string, to: string): void {
    // 更新内部状态
    this.currentSession = to;

    const phase = sessionToPhase(to, new Date().getHours());
    const transitionLabel = phase ? phaseLabel(phase) : to;

    for (const config of this.configs.values()) {
      if (!config.sessionChange.enabled) continue;
      if (config.sessionChange.targets.length === 0) continue;

      const text = `🔔 【交易时段转换】${from} → ${transitionLabel}
时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`;

      for (const target of config.sessionChange.targets) {
        const sessionKey = `${config.channelId}:${target}`;
        this.broadcast("chat", {
          sessionKey,
          state: "final",
          text,
          source: "session_change",
        }, { dropIfSlow: true });
      }
    }
  }

  // ============== 持久化 ==============

  /**
   * 配置不再落盘：渠道进程启动时通过 notifications.register 自注册，
   * 网关进程重启后由渠道重新注册即可（单机单人场景无需持久化）。
   */
  async load(): Promise<void> {
    // 保留方法以兼容既有调用点
  }
  // ============== 内部工具 ==============

  /** 从告警的 metrics 推断告警类型 */
  private inferAlertType(alert: MonitorAlert): string {
    const m = alert.metrics;
    if ("price_change_pct" in m || "amplitude" in m) return "price";
    if ("volume_ratio" in m || "turnover_rate" in m) return "volume";
    if ("capital_flow" in m || "north_flow" in m || "main_force_flow" in m) return "capital";
    if ("index_divergence" in m) return "index";
    if ("limit_up" in m || "limit_down" in m || "technical_break" in m) return "technical";
    return "unknown";
  }
}