/**
 * 交易时段（A 股，北京时间，按本机时钟粗粒度判断）
 *
 * 用途：MonitorManager 启动时的初始时段。若初值固定为 "idle"，盘中重启运行时会
 * 让监控瘦客户端误判为"时段已切换到 idle"（既误报时段，又误触发一次心跳 LLM）。
 *
 * 取值与瘦客户端 / server_app 约定一致：
 *   pre_open | morning | lunch | afternoon | idle
 */
export type TradingSession = 'pre_open' | 'morning' | 'lunch' | 'afternoon' | 'idle';

export function currentTradingSession(now = new Date()): TradingSession {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 9 * 60 + 30) return 'pre_open';   // 09:30 前（含集合竞价）
  if (minutes < 11 * 60 + 30) return 'morning';   // 09:30-11:30
  if (minutes < 13 * 60) return 'lunch';          // 11:30-13:00 午休
  if (minutes < 15 * 60) return 'afternoon';      // 13:00-15:00
  return 'idle';
}
