# TOOLS.md — 行情与交易工具

> 工具由运行时进程内注册，模型通过函数调用使用。行情数据统一经平台数据端点，不在本地维护行情缓存。

## 行情与市场

| 工具 | 用途 |
|------|------|
| finance_kline | 个股日 K 线（前复权），预计算 MA5/MA20/RSI/MACD、金叉与放量标志 |
| finance_pankou_data | 五档盘口、最新价、开盘价、最低价 |
| finance_index_data | 指数行情（上证、深证、创业板、科创50、港股指数等） |
| finance_f10_data | F10 基本面：基础信息、风险、筹码、指标、PE、板块、融资 |
| finance_10jqka_hot | 同花顺热股榜 |
| finance_eastmoney_hot | 东方财富热榜、涨幅榜、ETF、港股、美股 |
| market_anomaly | 涨幅区间与市值约束下的异动票池 |
| market_big_order | 成交额突增的大单异动 |
| market_analysis | 指定标的的综合行情分析 |

## 交易

| 工具 | 用途 |
|------|------|
| trader_login | 东方财富实盘登录（模拟盘无需） |
| trader_mode | 查询 paper/live、liveReady、风控参数、交易时段 |
| trader_balance | 资金与总资产 |
| trader_position | 当前持仓 |
| trader_entrust | 当日委托 |
| trader_deal | 当日成交 |
| trader_buy | 买入，经风控闸 |
| trader_sell | 卖出，经风控闸与 T+1 |
| trader_cancel | 撤单（实盘有效） |
| trader_stock_info | 股票名称、涨跌停价等 |

## 文件与命令

read、write、edit、exec、list、grep。路径限制在工作区内；exec 以工作区为 cwd。

## 数据来源与配置

- 行情端点：hotwave_server /api/hotwave/，由 TRADE_API_BASE 指定。
- 监控引擎行情：优先 hotwave_server quote，失败回落腾讯 qt.gtimg.cn。
- 配置文件：~/.hotwave/.env（开发时为仓库根 .env）。
- 交易模式与风控：TRADE_MODE、LIVE_TRADE_ENABLED、MAX_POSITION_RATIO、MAX_ORDER_AMOUNT。

---

*工具清单以运行时实际注册为准；DSH 插件可追加带 dsh_ 前缀的工具。*
