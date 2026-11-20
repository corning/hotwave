---
name: auto-trade
description: 自动交易策略执行——定时扫描持仓与自选，按 STRATEGY.md 规则评估买卖信号，经风控闸下单（模拟盘/实盘）。由 Heartbeat 盘中唤醒执行；异动告警只推送监控页/IM，不直接驱动下单。
---

# auto-trade — 自动交易策略执行

本技能承载「评估 → 决策 → 下单」的自动交易闭环。**策略规则与选股池在 `STRATEGY.md`**（工作区根目录，read 的相对路径即以工作区为根），执行前务必先 `read STRATEGY.md`。

## 触发场景
- **Heartbeat 定时**：盘中（09:25-15:00）每 N 分钟唤醒，扫描持仓与自选行情。
- **异动告警（仅展示）**：内置监控引擎（进程内）的异动只广播到监控页/IM，不唤醒 LLM；交易评估统一由 Heartbeat 执行，避免告警浅决策与心跳重复下单。

## 执行流程

1. **自检**：先调 `trader_mode` 确认 `mode` 与 `liveReady`，并确认当前处于 A 股交易时段。`mode=paper` 或 `liveReady=false` 才是安全的模拟盘；`liveReady=true` 时必须先获得用户明确授权，否则只分析不下单。
2. **读策略**：`read STRATEGY.md`，获取选股池、买入条件、卖出条件、仓位规则、止盈止损。
3. **查持仓与资金**：`trader_balance` + `trader_position`，掌握当前仓位与可用资金。
4. **评估信号**：用 `finance_*` 工具取行情/资金流/技术指标，对照 STRATEGY.md 规则判断每只标的的买卖信号。
5. **下单**：对触发信号的标的调 `trader_buy` / `trader_sell`，`strategy_tag` 填 `heartbeat`。价格传 0 表示用最新价撮合（模拟盘）。
6. **风控由 TradeRouter 兜底**：单票仓位上限、单笔金额上限、T+1 卖出校验。若被风控拒绝，记录原因不下单。

## 输出规范
- 每轮简要列出：扫描标的数、触发信号、已下单明细、被风控拒绝项。
- 不下单时明确说明原因（无信号 / 风控拒绝 / 非交易时段 / 实盘未授权）。
- 涉及个股用 `[名称(代码)](stock:代码)` 标注（详见 system prompt 股票标注规范）。

## 安全约束
- 模拟盘（paper）不下真实委托，可放心验证策略。
- 实盘（live）需 `TRADE_MODE=live` 且 `LIVE_TRADE_ENABLED=true` 双重开启；否则自动降级为模拟盘。
- 任何模式都受 `MAX_POSITION_RATIO` / `MAX_ORDER_AMOUNT` 风控约束。
- 不绕过风控闸直接调底层交易接口。

### 实盘专属风控（TradeRouter 兜底，无需手动遵守）
- 仅允许 A 股交易时段（北京时间 09:25-11:30 / 13:00-15:00）下单（`LIVE_TRADE_SESSION_ONLY`）。
- 每日实盘下单次数上限 `MAX_LIVE_ORDERS_PER_DAY`（默认 20）。
- 实盘必须提供明确限价（`price=0` 仅模拟盘可用）。
- ST/退市股票禁止买卖。
- 涨停封死禁止买入、跌停封死禁止卖出。
- 卖出须有可用持仓（含 T+1 限制）。
- 实盘委托落库状态为 `pending`，成交与否需后续查 `trader_entrust` / `trader_deal` 确认。
