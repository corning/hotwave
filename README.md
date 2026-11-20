# HotWave 热浪

> 面向 A 股市场的金融 AI Agent 终端：对话式投研、行情工具、模拟/实盘交易、实时监控与定时决策，全部运行在一个 Node.js 进程里。

![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178c6)
![License](https://img.shields.io/badge/license-MIT-blue)

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 功能特性](#2-功能特性)
- [3. 与平台组件的关系](#3-与平台组件的关系)
- [4. 系统架构](#4-系统架构)
- [5. 目录结构](#5-目录结构)
- [6. 快速开始](#6-快速开始)
- [7. 配置参考](#7-配置参考)
- [8. 使用指南](#8-使用指南)
- [9. 接口](#9-接口)
- [10. 工具清单](#10-工具清单)
- [11. 交易与风控](#11-交易与风控)
- [12. 监控、心跳与通知](#12-监控心跳与通知)
- [13. 持久化一览](#13-持久化一览)
- [14. 开发与测试](#14-开发与测试)
- [15. 排障](#15-排障)
- [16. 安全与免责](#16-安全与免责)
- [17. 贡献](#17-贡献)
- [18. License](#18-license)

---

## 1. 项目简介

HotWave（热浪）是一个开源的金融 Agent 运行时，面向 A 股市场。它把大模型、工具调用、行情数据、交易通道、风控、监控和定时任务装进同一个进程，对外提供 HTTP/SSE 与 WebSocket RPC 两种接入方式。

它解决三件事：

1. **让模型查得到**：K 线、盘口、F10、指数、热榜、异动、大单、账户、持仓、委托、成交，全部以工具形式暴露给模型。
2. **让模型做得到**：模拟盘与实盘下单、撤单、清仓，统一经过风控闸与交易记录。
3. **让模型自己动**：进程内监控引擎发现异动，心跳定时唤醒模型读取策略文件并做买卖决策，结果推送到 IM 或 APP。

设计取向：

- **单进程**：交易、监控、通知、审批只有一份状态，避免多进程争抢同一账户。
- **默认安全**：默认模拟盘、默认只监听回环地址、实盘需要双重开关。
- **文件即配置**：人格、策略、记忆都是工作区里的 Markdown，改完即生效。
- **可观测**：健康检查、状态快照、监控引擎状态、心跳触发与跳过原因都可查。

适用场景：

- 个人 A 股投研与盘面监控
- 模拟盘策略验证与交易纪律训练
- 把 LLM 接入自有行情端点或交易通道的二次开发
- 通过 IM 机器人远程使用同一个 Agent

---

## 2. 功能特性

| 能力 | 说明 |
|------|------|
| 对话式投研 | HTTP/SSE 与 WebSocket chat，流式输出推理、工具状态与最终答复 |
| 26 个内置工具 | 9 个行情工具、10 个交易工具、6 个文件/命令工具、1 个 OCR 工具 |
| 模拟盘 / 实盘 | 默认模拟盘；实盘需同时开启 TRADE_MODE=live 与 LIVE_TRADE_ENABLED=true |
| 统一风控闸 | 交易时段、单笔金额、单票仓位；实盘另有 ST、涨跌停、限价、每日次数、可用持仓校验 |
| 进程内监控 | 默认 5 秒轮询自选与指数，涨跌幅/放量/涨跌停阈值触发告警，60 秒同标的冷却 |
| 心跳决策 | 默认 10 分钟唤醒一次，注入 HEARTBEAT.md 与 STRATEGY.md，由模型自主分析并下单 |
| 通知路由 | 心跳简报、监控告警、时段切换按渠道配置推送到 Telegram/飞书/钉钉/微信 |
| 多模型 | 基于 pi-ai，支持 Anthropic、OpenAI 及 OpenAI 兼容端点 |
| 工作区记忆 | SOUL/USER/MEMORY/HEARTBEAT 等 Markdown 文件由 Agent 读写，跨会话保留 |
| 验证码识别 | 本机 ddddocr，按需启动一次性 Python 进程，无端口、无常驻服务 |
| DSH 插件兼容 | 可加载 DeepSeek Harness 生态插件，工具自动镜像进注册表 |
| 单实例保护 | 运行时锁 + 绑定锁，避免同一账户被多个进程同时操作 |

---

## 3. 与平台组件的关系

HotWave 可以独立运行，也可以作为“热力追踪”平台体系中的客户端 Agent 接入平台。

| 组件 | 角色 | 是否在本仓库 |
|------|------|--------------|
| **hotwave** | 客户端 Agent 运行时，本仓库 | 是 |
| server_app | 平台服务：行情聚合、交易落库、APP 桥接、管理 API | 否，可选 |
| admin | 平台管理后台 | 否，可选 |
| flutter_user_app | 用户 APP | 否，可选 |

两种运行形态：

- **独立模式（默认）**：不配置 TRADE_BINDING_ID / TRADE_BINDING_SECRET。交易可以照常执行，但不会落库到平台，也不会接入 APP。行情类工具仍需要一个兼容 server_app 数据契约的端点，仓库本身不包含该服务。
- **平台绑定模式**：配置绑定凭证后，HotWave 通过反向 WebSocket 主动连接 server_app，接受平台下发的 chat、monitor、trader 调用；成交记录、执行日志、心跳简报写回平台，APP 可远程查看与控制。

> 平台侧组件不在本仓库中，可用性和部署方式由平台自身决定。独立部署 HotWave 时，请自备兼容的数据端点，或只使用文件/命令工具与本地模拟盘。

---

## 4. 系统架构

### 4.1 单进程拓扑

~~~
                    ┌──────────────────────── HotWave 运行时（单进程） ────────────────────────┐
                    │                                                                          │
  LLM Provider ◀───▶│  Agent Loop ──▶ Tool Registry ──▶ 行情 / 交易 / 文件 / OCR              │
                    │       │                 │                                                │
  IM / 桌面 / CLI   │  HTTP/SSE :8791    ┌────┴────┐                                           │
  ◀────────────────▶│  控制面            │         │                                           │
                    │  WS RPC  :18789 ◀──┘         ├──▶ TradeRouter ──▶ PaperTrader / 东方财富  │
                    │                              ├──▶ MonitorEngine ──▶ 告警 / 通知            │
  server_app :18791 │  反向长连接（HotWave 为 client）└──▶ Heartbeat ──▶ LLM 决策 ──▶ STRATEGY.md│
  ◀────────────────▶│  NotificationRouter ──▶ Telegram / 飞书 / 钉钉 / 微信                    │
                    └──────────────────────────────────────────────────────────────────────────┘
~~~

三个网络端口：

| 端口 | 方向 | 用途 | 配置变量 |
|------|------|------|----------|
| 8791 | 入站 HTTP | 运行时 HTTP/SSE、控制面、监控上报 | AGENT_RUNTIME_HOST / AGENT_RUNTIME_PORT |
| 18789 | 入站 WS + HTTP | 内嵌网关 RPC，供 IM、桌面端、CLI、平台接入 | HOTWAVE_GW_HOST / HOTWAVE_GW_PORT |
| 18791 | 出站 WS | HotWave 主动连接 server_app，仅绑定模式启用 | TRADE_API_WS_URL |

端口固定不递延：任一端口被占用，进程直接启动失败，保证同一时刻只有一个实例。

### 4.2 模块分层

| 层 | 目录 | 职责 |
|----|------|------|
| 内核 | [src/kernel](src/kernel) | Agent 循环、流式事件、工具契约与注册表、参数校验、SSE 编码 |
| 运行时 | [src/runtime](src/runtime) | 组合根、服务插件、会话 Agent、模型描述、双通道状态 |
| 网关 | [src/runtime/rpc](src/runtime/rpc) | 帧协议、WS 服务、RPC 方法、监控引擎、通知路由、反向连接 |
| 工具 | [src/tools](src/tools) | 行情工具、交易工具、文件/命令工具、server_app 数据客户端 |
| 交易 | [src/trader](src/trader) | 交易路由、模拟盘、东方财富实盘、交易记录、验证码识别 |
| 渠道 | [src/channels](src/channels) | Telegram、飞书、钉钉、微信适配器 |
| 通用 | [src/common](src/common) | 路径解析、环境加载、单实例锁、OCR、审批类型、股票标注 |
| 能力 | [src/capabilities](src/capabilities) | 长期记忆索引与关键词检索 |

几个关键文件：

- [src/kernel/agent-loop.ts](src/kernel/agent-loop.ts)：自研 Agent 循环，调用 pi-ai 的 streamSimple，处理工具调用、轮次预算和收尾兜底。
- [src/kernel/plugin.ts](src/kernel/plugin.ts)：极简插件内核，提供 provide/get、inject 依赖门控、effect 生命周期。
- [src/kernel/tools.ts](src/kernel/tools.ts)：工具定义、JSON Schema 校验、超时与取消、批量执行。
- [src/runtime/server.ts](src/runtime/server.ts)：单进程入口，启动 HTTP、内嵌网关、监控、心跳。
- [src/runtime/rpc/handlers.ts](src/runtime/rpc/handlers.ts)：23 个 RPC 方法的实现。
- [src/trader/router.ts](src/trader/router.ts)：交易路由与全部风控闸。
- [src/runtime/rpc/monitor-engine.ts](src/runtime/rpc/monitor-engine.ts)：进程内行情轮询与异动检测。

### 4.3 一次对话

1. 客户端通过 HTTP **POST /chat/send** 或 RPC **chat.send** 发送消息。
2. 运行时携带系统提示与历史消息调用 **runAgent**。
3. 模型流式返回文本与推理内容，分别编码为 **delta** 与 **reasoning**。
4. 模型返回工具调用时，**ToolRegistry** 校验参数、执行工具、回填结果。
5. 循环继续，直到模型不再调用工具、达到轮次上限或客户端中断。
6. HTTP 侧输出 **final** 与 **done**；网关侧广播 **chat final**。

系统提示默认由内置的 A 股分析师人设提供，可用 **AGENT_SYSTEM_PROMPT** 覆盖。

### 4.4 一次心跳决策

1. **KernelAgent** 在活跃时段内按间隔触发心跳。
2. 读取工作区 **HEARTBEAT.md**，按本机时间（建议 TZ=Asia/Shanghai）构造盘前/盘中/盘后提示。
3. 盘中额外读取 **STRATEGY.md**，把完整策略注入提示。
4. 心跳在 **_heartbeat_** 会话、独立 lane 中运行，不打断用户对话。
5. 模型调用行情、账户、持仓工具，按策略自主决定是否买卖。
6. 结果推送到 IM 渠道，并在配置绑定后写入平台心跳简报。

### 4.5 一次下单

1. 模型调用 **trader_buy** 或 **trader_sell**。
2. 交易插件执行三道前置：dry-run 判断、审批策略判断、写类工具串行锁。
3. **TradeRouter** 校验交易时段、单笔金额、单票仓位；实盘再做 ST、涨跌停、限价、每日次数、可用持仓校验。
4. 路由到 **PaperTrader** 或 **EastMoneyTrader**。
5. 成交或委托提交后，写交易记录与执行日志；未配置绑定时跳过。
6. 结果文本返回给模型，由模型向用户解释。

---

## 5. 目录结构

~~~
.
├── src/
│   ├── cli.ts                  CLI 入口（init / start / paths / doctor）
│   ├── index.ts                包公开 API
│   ├── kernel/                 Agent 循环与插件内核
│   │   ├── agent-loop.ts
│   │   ├── plugin.ts
│   │   ├── schema.ts
│   │   ├── sse.ts
│   │   ├── tools.ts
│   │   └── compat/             DSH 插件兼容宿主与工具镜像
│   ├── runtime/
│   │   ├── server.ts           单进程入口
│   │   ├── plugins.ts          组合根
│   │   ├── kernel-agent.ts     会话与心跳
│   │   ├── model.ts            模型描述
│   │   ├── state.ts            chat / heartbeat 双通道状态
│   │   └── rpc/                网关、监控、通知、反向连接
│   ├── tools/                  行情 / 交易 / 文件命令工具
│   ├── trader/                 交易路由、模拟盘、实盘、落库、验证码
│   ├── channels/               IM 渠道
│   ├── capabilities/           长期记忆
│   ├── common/                 路径、环境、锁、OCR 等
│   └── dev/selftest.ts         全功能自测
├── scripts/dev.mjs             开发启动器（自动选择 Node >= 22）
├── workspace-templates/        Agent 工作区模板
├── skills/auto-trade/          自动交易技能说明
├── requirements.txt            OCR 的 Python 依赖
├── .env.example                配置模板
└── README.md
~~~

---

## 6. 快速开始

### 6.1 环境要求

- **Node.js >= 22**。运行时启动时会硬性检查，低版本直接退出。macOS 上如果 nvm 被系统 Node 遮蔽，**pnpm dev** 会自动切换到可用版本。
- **pnpm >= 10**（仓库锁定 pnpm 10.23）。
- **Python 3**（可选）。只有实盘登录验证码识别需要，由 **hotwave init** 自动创建虚拟环境。
- **模型 API Key**。至少配置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 之一。
- **行情数据端点**（可选但强烈建议）。行情工具默认访问 server_app 的 **/api/hotwave/** 契约；没有该端点时，行情类工具会报“数据服务不可用”。
- **时区**。建议设置 **TZ=Asia/Shanghai**。交易时段校验会显式换算北京时间，但心跳阶段判断和监控时段使用本机时区。

### 6.2 安装

~~~bash
git clone https://github.com/corning/hotwave.git
cd hotwave
pnpm install
~~~

### 6.3 最小配置

在仓库根目录复制配置模板：

~~~bash
cp .env.example .env
~~~

编辑 **.env**，至少填写模型与 Key：

~~~env
HOTWAVE_PROVIDER=openai
HOTWAVE_MODEL=你的模型ID
HOTWAVE_BASE_URL=https://你的-openai-兼容端点/v1
OPENAI_API_KEY=sk-xxx

TZ=Asia/Shanghai
TRADE_MODE=paper
LIVE_TRADE_ENABLED=false
~~~

Provider 与 API 协议映射：

| HOTWAVE_PROVIDER | 使用的 pi-ai 协议 | 典型场景 |
|------------------|-------------------|----------|
| anthropic | anthropic-messages | Anthropic 官方或兼容代理 |
| openai | openai-completions | OpenAI、DeepSeek、Kimi、智谱等兼容服务 |
| google | google-generative-ai | Gemini |

运行时启动时只从 **ANTHROPIC_API_KEY** 或 **OPENAI_API_KEY** 读取 Key；使用其他 provider 时，请把 Key 放入这两个变量之一。

### 6.4 启动与验证

~~~bash
pnpm dev
~~~

首次启动会创建 **~/.hotwave**，并输出 home、workspace、工具数量、模型、审批策略和端口信息。验证：

~~~bash
curl http://127.0.0.1:8791/health
~~~

预期返回：

~~~json
{
  "ok": true,
  "service": "hotwave-agent-runtime",
  "engine": "kernel",
  "singleProcess": true,
  "tools": 26,
  "uptimeSec": 3
}
~~~

再发一条对话：

~~~bash
curl -N http://127.0.0.1:8791/chat/send \
  -H 'Content-Type: application/json' \
  -d '{"content":"你好，简单介绍一下你能做什么"}'
~~~

会看到 **delta**、**thinking**、**final**、**done** 等 SSE 事件。

### 6.5 安装为全局命令

~~~bash
pnpm build
npm i -g .
hotwave init
hotwave doctor
hotwave start
~~~

**hotwave start** 运行的是 **dist** 构建产物；源码改动后需要重新 **pnpm build**。

### 6.6 首次启动做了什么

**ensureHotwaveHome** 是幂等初始化，顺序如下：

1. 创建 **~/.hotwave** 下的 workspace、config、sessions、logs。
2. 若用户级 workspace 为空，且当前目录存在非空 **workspace/**，整目录拷贝迁移（原目录保留）。
3. 若仍为空，铺入 **workspace-templates/**。
4. 若 **~/.hotwave/.env** 不存在：优先迁移当前目录 **.env**，否则复制 **.env.example**，权限设为 600。
5. 迁移当前目录的 **eastmoney_trader.session** 与 **config/dsh-plugins.json**（如果存在）。
6. 写入 **~/.hotwave/.init.json** 作为初始化标记。

---

## 7. 配置参考

### 7.1 加载顺序

1. **~/.hotwave/.env**
2. **当前工作目录/.env**（覆盖前者）

开发时把 **.env** 放在仓库根目录即可；全局安装后建议只维护 **~/.hotwave/.env**。

### 7.2 模型与运行时

| 变量 | 默认值 | 说明 |
|------|--------|------|
| HOTWAVE_PROVIDER | anthropic | anthropic / openai / google |
| HOTWAVE_MODEL | deepseek-chat | 不建议依赖默认值，请显式设置并确保与 provider 匹配 |
| HOTWAVE_BASE_URL | 空 | 代理、自建端点或兼容服务地址 |
| ANTHROPIC_API_KEY | 空 | Anthropic 协议 Key |
| OPENAI_API_KEY | 空 | OpenAI 协议 Key |
| AGENT_SYSTEM_PROMPT | 内置 A 股分析师提示 | 覆盖系统提示 |
| AGENT_MAX_TURNS | 6 | 单次 run 最大轮次 |
| AGENT_MAX_TOKENS | 8192 | 单轮输出 token 上限 |
| AGENT_RUNTIME_HOST | 127.0.0.1 | HTTP 监听地址 |
| AGENT_RUNTIME_PORT | 8791 | HTTP 端口 |
| AGENT_RUNTIME_TOKEN | 空 | 设置后所有 HTTP 请求需 Bearer Token |
| HOTWAVE_GW_HOST | 127.0.0.1 | 网关监听地址 |
| HOTWAVE_GW_PORT | 18789 | 网关端口 |
| HOTWAVE_GW_TOKEN | 空 | 网关 connect 握手 Token |
| HOTWAVE_GW_URL | ws://localhost:18789 | 渠道进程连接网关的地址 |
| HOTWAVE_HOME | ~/.hotwave | 数据根目录，兼容旧别名 HOTWAVE_CONFIG_DIR |
| AGENT_WORKSPACE | HOTWAVE_HOME/workspace | 工作区目录 |
| HOTWAVE_DEV_WORKSPACE | 未设置 | 仅 pnpm dev：home 或指定路径 |
| TZ | 系统时区 | 建议 Asia/Shanghai |

### 7.3 交易与风控

| 变量 | 默认值 | 说明 |
|------|--------|------|
| TRADE_MODE | paper | paper 模拟盘 / live 实盘 |
| LIVE_TRADE_ENABLED | false | 实盘第二道开关，false 时即使 live 也按模拟盘 |
| TRADE_DRY_RUN | false | true 时写类交易工具只预演，不触达交易通道 |
| PAPER_INITIAL_CASH | 1000000 | 模拟盘初始资金 |
| MAX_POSITION_RATIO | 0.3 | 单票仓位上限，占总资产比例 |
| MAX_ORDER_AMOUNT | 100000 | 单笔金额上限，单位元 |
| LIVE_TRADE_SESSION_ONLY | true | 实盘是否仅允许交易时段下单 |
| MAX_LIVE_ORDERS_PER_DAY | 20 | 实盘每日下单次数上限 |
| STOCK_ACCOUNT_USERNAME | 空 | 东方财富实盘账号 |
| STOCK_ACCOUNT_PASSWORD | 空 | 东方财富实盘密码 |
| APPROVAL_MODE | always-auto | always-auto 全部放行 / guarded 写类工具拦截 |

### 7.4 平台绑定与落库

| 变量 | 默认值 | 说明 |
|------|--------|------|
| TRADE_API_BASE | http://localhost:8000/api | 平台 REST API 前缀，行情工具也用它 |
| TRADE_API_WS_URL | ws://localhost:18791 | 平台反向 WS 地址 |
| TRADE_BINDING_ID | 空 | HotWave 绑定的用户/实例 ID |
| TRADE_BINDING_SECRET | 空 | 绑定密钥，随请求头 X-Binding-Id / X-Binding-Secret 发送 |

未配置绑定时进入独立模式：不建立反向连接，交易记录、执行日志、平台心跳简报全部跳过；心跳本身仍会运行，并照常推送到已注册的 IM 渠道。

### 7.5 监控

| 变量 | 默认值 | 说明 |
|------|--------|------|
| MONITOR_ENABLED | true | 仅当值为字符串 false 时关闭 |
| MONITOR_INDEX_LIST | 4 个默认指数 | 逗号分隔，覆盖默认监控指数 |
| MONITOR_INTERVAL | 5 | 轮询间隔，单位秒 |
| MONITOR_INTERVAL_MS | 未设置 | 毫秒级间隔，优先级高于 MONITOR_INTERVAL |
| MONITOR_PRICE_PCT | 3.0 | 涨跌幅异动阈值，单位 % |
| MONITOR_VOLUME_RATIO | 2.0 | 放量倍数阈值 |
| MONITOR_QUOTE_SOURCE | auto | auto / server_app / tencent |

默认监控指数：上证指数 sh000001、深证成指 sz399001、创业板指 sz399006、科创50 sh000688。

### 7.6 心跳

| 变量 | 默认值 | 说明 |
|------|--------|------|
| HOTWAVE_HEARTBEAT | true | 仅当值为字符串 false 时关闭 |
| HOTWAVE_HEARTBEAT_INTERVAL_MS | 600000 | 心跳间隔，默认 10 分钟 |
| HEARTBEAT_START | 09:00 | 活跃时段开始 |
| HEARTBEAT_END | 15:20 | 活跃时段结束 |
| HEARTBEAT_MAX_TOOL_TURNS | 4 | 单轮心跳的工具轮次预算 |
| AGENT_HEARTBEAT_FILE | 工作区/HEARTBEAT.md | 巡检清单路径 |
| AGENT_HEARTBEAT_STATE | 工作区/.heartbeat-state.json | 上次触发时间状态文件 |

### 7.7 审批

| 变量 | 默认值 | 说明 |
|------|--------|------|
| APPROVAL_MODE | always-auto | guarded 时写类工具返回“需要人工审批”，不自动执行 |

### 7.8 IM 渠道

| 变量 | 说明 |
|------|------|
| TELEGRAM_BOT_TOKEN | Telegram Bot Token |
| TELEGRAM_NOTIFY_TARGETS | 通知目标 chatId，逗号分隔 |
| FEISHU_APP_ID / FEISHU_APP_SECRET | 飞书应用凭证 |
| FEISHU_VERIFICATION_TOKEN / FEISHU_ENCRYPT_KEY | 飞书事件校验与解密 |
| FEISHU_NOTIFY_TARGETS | 通知目标 chatId / openId，逗号分隔 |
| DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET | 钉钉 Stream 模式凭证 |
| DINGTALK_NOTIFY_TARGETS | 通知目标 userId，逗号分隔 |
| WECHAT_BOT_TOKEN | 微信 iLink Bot Token |
| WECHAT_BOT_BASE_URL | 微信 Bot 服务地址 |
| WECHAT_BOT_ACCOUNT_ID | 微信 Bot 账号 ID |
| WECHAT_NOTIFY_TARGETS | 通知目标 wxid，逗号分隔 |
| CHANNELS_ENABLED | true 时在运行时进程内启动渠道 |
| CHANNELS | 逗号分隔，指定启动哪些渠道；留空则自动启动已配置凭证的渠道 |

### 7.9 OCR

| 变量 | 默认值 | 说明 |
|------|--------|------|
| HOTWAVE_PYTHON | 自动探测 | 指定已装 ddddocr 的 Python 解释器 |
| HOTWAVE_PIP_INDEX | 清华镜像 | pip 安装源 |

解释器探测顺序：HOTWAVE_PYTHON → ~/.hotwave/venv → 包根/.venv → PATH 中的 python3。

### 7.10 DSH 插件兼容

| 变量 | 说明 |
|------|------|
| DSH_PLUGINS | 逗号分隔的插件包名 |
| DSH_PLUGIN_CONFIG | 插件清单 JSON 路径 |
| DSH_TOOL_PREFIX | 镜像工具名前缀，默认 dsh_ |

清单文件也可放在 **~/.hotwave/config/dsh-plugins.json**，格式：

~~~json
[
  { "package": "@scope/dsh-plugin-xxx", "config": { "key": "value" } }
]
~~~

---

## 8. 使用指南

### 8.1 CLI

| 命令 | 作用 |
|------|------|
| hotwave init | 初始化 ~/.hotwave，安装工作区模板、.env 模板与 OCR 依赖，幂等 |
| hotwave init --no-ocr | 跳过 OCR 依赖安装，可省约 500 MB 磁盘 |
| hotwave start | 启动运行时；支持 --take-over 接管旧实例 |
| hotwave paths | 打印数据目录、工作区、.env、config、sessions、OCR venv 的解析结果 |
| hotwave doctor | 自检 Node、目录、端口、配置、实例锁、OCR |
| hotwave --version | 打印版本 |

### 8.2 npm scripts

| 命令 | 作用 |
|------|------|
| pnpm dev | tsx 直接跑源码，开发默认使用仓库内 workspace |
| pnpm start | 跑 dist 构建产物，使用 ~/.hotwave/workspace |
| pnpm build | tsc 编译到 dist |
| pnpm test:integration | 全功能自测，需要本机运行时与 server_app 同时在线 |
| pnpm channel:start <name> | 单独启动一个 IM 渠道 |
| pnpm channels:all | 启动所有已配置凭证的渠道 |

**pnpm dev** 会在当前 Node 低于 22 时自动从 NODE_BIN、nvm、/usr/local/bin、/opt/homebrew 中挑选可用版本。

开发工作区规则：

- 默认使用 **仓库根/workspace**，方便直接改 SOUL/MEMORY/HEARTBEAT。
- **HOTWAVE_DEV_WORKSPACE=home pnpm dev** 使用 **~/.hotwave/workspace**，与常驻一致。
- **HOTWAVE_DEV_WORKSPACE=/path pnpm dev** 使用指定目录。
- **AGENT_WORKSPACE** 显式设置时优先级最高。

### 8.3 端口与单实例

HotWave 同一时间只允许一个运行时。启动时获取两把锁：

- **~/.hotwave/runtime.lock**：同一数据目录只允许一个实例。
- **<tmpdir>/hotwave-binding-<hash>.lock**：同一 TRADE_BINDING_ID 只允许一个实例。

已有实例时，默认打印对方 pid、端口、工作区，并以退出码 1 结束。接管方式：

~~~bash
pnpm dev -- --take-over
hotwave start --take-over
~~~

若旧实例由 launchd 或 systemd 托管，请先停止对应服务，再使用 take-over，避免被守护进程重新拉起。

### 8.4 工作区与记忆

默认目录结构：

~~~
~/.hotwave/
├── .env                 配置，权限 600
├── workspace/           Agent 工作区
│   ├── AGENTS.md        工作区总则与分析框架
│   ├── SOUL.md          交易员信条与语气
│   ├── IDENTITY.md      身份卡
│   ├── USER.md          投资者画像
│   ├── MEMORY.md        长期记忆
│   ├── HEARTBEAT.md     定时巡检清单
│   ├── TOOLS.md         工具与数据源说明
│   ├── BOOTSTRAP.md     首次对话引导
│   ├── STRATEGY.md      可选，盘中决策策略
│   ├── memory/          每日复盘与记忆索引
│   └── .heartbeat-state.json
├── config/              dsh-plugins.json
├── sessions/            eastmoney_trader.session
├── venv/                OCR Python 虚拟环境
└── logs/
~~~

工作区是 Agent 的长期上下文：

- 每次会话开始时可读取 SOUL、USER、IDENTITY、MEMORY 与最近复盘。
- 盘中心跳会把 **STRATEGY.md** 注入提示；文件不存在时只做行情分析。
- 每日复盘写入 **memory/YYYY-MM-DD.md**。
- 心跳上次触发时间写入 **.heartbeat-state.json**，重启后按“上次 + 间隔”续算。

注意：**对话历史保存在进程内存**，重启后清空；工作区文件、交易记录、心跳状态才是持久化载体。

### 8.5 IM 渠道

四种渠道通过统一的 GatewayClient 连接内嵌网关，消息走 **chat.send**。Session Key 规范为 **渠道:标识**。

| 渠道 | 连接方式 | SDK | Session Key 示例 |
|------|----------|-----|------------------|
| Telegram | Bot API 轮询 | grammy | telegram:chatId |
| 飞书 | WebSocket 长连接 | @larksuiteoapi/node-sdk | feishu:open_id / feishu:chat_id |
| 钉钉 | Stream 模式 WebSocket | dingtalk-stream | dingtalk:senderId |
| 微信 | HTTP 长轮询 | iLink Bot API | wechat:wxid / wechat:groupId |

两种启动方式：

~~~bash
# 方式一：运行时进程内启动（推荐）
CHANNELS_ENABLED=true CHANNELS=telegram,feishu pnpm dev

# 方式二：独立进程，先启动运行时，再另开终端
pnpm channel:start telegram
pnpm channels:all
~~~

渠道内命令：**/reset** 重置当前会话，**/health** 查询网关状态；Telegram 另有 **/start**。

群聊通常只在被 @ 时响应。

### 8.6 DSH 插件

运行时默认加载 DSH 兼容插件；配置插件清单后才创建兼容宿主，插件工具会镜像进 HotWave 工具注册表，默认加 **dsh_** 前缀，避免与内置工具重名。

插件包需能被 Node 解析，通常先在 **~/.hotwave/config** 或项目目录安装：

~~~bash
cd ~/.hotwave/config
pnpm add @scope/dsh-plugin-xxx
~~~

然后通过 **DSH_PLUGINS** 或 **dsh-plugins.json** 指定。需要 agent 作用域的工具可能无法执行，但 schema 仍可被模型看到。

---

## 9. 接口

### 9.1 HTTP

设置 **AGENT_RUNTIME_TOKEN** 后，以下所有请求都需要 **Authorization: Bearer <token>**。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 运行时健康检查与工具数量 |
| GET | /state | chat 与 heartbeat 双通道状态、模型、工具数、心跳信息 |
| POST | /chat/abort | 中断当前 chat run，不影响心跳 lane |
| POST | /chat/send | 发起对话，返回 SSE 流 |
| GET | /monitor/status | 监控清单、告警历史、引擎状态 |
| POST | /monitor/subscribe | 新增监控标的 |
| POST | /monitor/unsubscribe | 移除监控标的 |
| POST | /monitor/session | 上报交易时段切换 |
| POST | /monitor/ingest | 上报一条异动告警 |
| GET | /approvals | 本地待审批列表 |
| POST | /approvals/:id | 从本地待审批列表移除 |

监控相关 HTTP 入口复用网关 handler，与 RPC 使用同一份 MonitorManager 状态。

### 9.2 SSE 事件

**POST /chat/send** 返回 **text/event-stream**，事件如下：

| event | data | 说明 |
|-------|------|------|
| delta | content | 增量文本 |
| reasoning_delta | text | 模型推理内容 |
| thinking | tool | 工具开始，或纯思考状态 tool 为空 |
| thinking_done | tool, isError | 工具结束 |
| final | content | 最终完整文本，股票代码已转可点击链接 |
| error | message | 运行错误 |
| done | messageId | 流结束 |

另有每 15 秒一次的 **: ping** 注释帧，防止中间层空闲断链。

### 9.3 WebSocket RPC

网关地址 **ws://127.0.0.1:18789**，同一端口也响应普通 HTTP GET，返回网关服务信息。

协议帧：

| 帧 | 方向 | 字段 |
|----|------|------|
| req | 客户端 → 服务端 | type, id, method, params |
| res | 服务端 → 客户端 | type, id, ok, payload, error |
| event | 服务端 → 客户端 | type, event, payload, seq |

握手流程：

~~~
Server                                  Client
  │◀──────── WebSocket 连接建立 ──────────│
  ├─ event: connect.challenge ───────────▶│  nonce, ts
  │◀──────── req: connect ────────────────┤  token, nonce
  ├─ 校验 Token 与 nonce                  │
  ├─ res: HelloOk ───────────────────────▶│  protocol, methods, events, policy
~~~

超时与限制：握手 10 秒，请求 60 秒，tick 30 秒，单帧最大 512 KB，慢消费者缓冲上限 1.5 MB。

### 9.4 RPC 方法

对外声明 21 个，另有 2 个扩展方法。

| 分组 | 方法 | 说明 |
|------|------|------|
| 系统 | connect, health | 握手、网关健康 |
| 会话 | chat.send, chat.history, chat.abort, sessions.list, sessions.reset | 聊天与历史 |
| 控制 | agent.state, approval.list, approval.decide | 状态与审批 |
| 监控 | monitor.subscribe, monitor.unsubscribe, monitor.status, monitor.instruct, monitor.search_stocks | 监控清单与指令 |
| 交易 | trader.balance, trader.liquidate, trader.status | 余额、清仓、状态 |
| 通知 | notifications.register, notifications.unregister, notifications.config | 渠道自注册与配置 |
| 扩展 | heartbeat.trigger, notifications.deliver | 立即触发心跳、主动投递通知 |

**trader.liquidate** 仅实盘可用，且要求处于交易时段。

### 9.5 chat 事件

**chat.send** 先 ACK 返回 **runId**，随后以 **chat** 事件流式推送：

| state | 字段 | 说明 |
|-------|------|------|
| thinking | tool | 工具执行中；tool 为空表示模型思考中 |
| reasoning | text | 推理内容增量 |
| delta | text | 正文增量 |
| thinking_done | tool, isError | 工具结束 |
| final | text | 整轮结束后的完整文本 |
| error | error | 运行错误 |

同时会广播原始 **agent** 事件，供需要细粒度事件的客户端使用。

### 9.6 server_app 反向连接

仅在配置 **TRADE_BINDING_ID / TRADE_BINDING_SECRET** 时启用：

1. HotWave 作为客户端连接 **TRADE_API_WS_URL**。
2. 平台发送 **connect.challenge**，HotWave 回复 bindingId、secret、nonce。
3. 认证成功后，平台可经该连接下发 chat、monitor、trader、approval 等 RPC。
4. HotWave 通过该连接上行 chat 增量、监控告警、审批事件与状态变化。

连接带指数退避重连、30 秒保活、5 分钟僵死判定。

---

## 10. 工具清单

默认注册 26 个工具。DSH 插件可在此基础上追加。

### 行情与市场（9）

| 工具 | 用途 |
|------|------|
| finance_kline | 个股日 K 线（前复权），预计算 MA5/MA20/RSI/MACD、金叉与放量标志 |
| finance_pankou_data | 五档盘口、最新价、开盘价、最低价 |
| finance_index_data | 指数行情，支持沪深、港股等 |
| finance_f10_data | F10 基本面：基础、风险、筹码、指标、PE、板块、融资 |
| finance_10jqka_hot | 同花顺热股榜 |
| finance_eastmoney_hot | 东方财富热榜、涨幅榜、ETF、港股、美股 |
| market_anomaly | 涨幅区间与市值约束下的异动票池 |
| market_big_order | 成交额突增的大单异动 |
| market_analysis | 指定标的的综合行情分析 |

行情工具统一走 **server_app /api/hotwave/** 数据端点，不做外部直连降级。

### 交易（10）

| 工具 | 用途 |
|------|------|
| trader_login | 东方财富实盘登录，模拟盘无需 |
| trader_mode | 查询 paper/live、风控状态、交易时段、实盘就绪 |
| trader_balance | 资金与总资产 |
| trader_position | 当前持仓 |
| trader_entrust | 当日委托 |
| trader_deal | 当日成交 |
| trader_buy | 买入，经风控闸 |
| trader_sell | 卖出，经风控闸与 T+1 |
| trader_cancel | 撤单，实盘有效 |
| trader_stock_info | 股票名称、涨跌停价等 |

### 文件与命令（6）

| 工具 | 用途 |
|------|------|
| read | 读取工作区内文件，带行号 |
| write | 覆盖写入工作区内文件 |
| edit | 替换工作区内文件中的文本 |
| exec | 在工作区执行 shell 命令 |
| list | 列出工作区目录 |
| grep | 在工作区内按正则搜索 |

文件工具的路径被限制在工作区内；**exec** 以工作区为 cwd，但不是操作系统级沙箱，只应搭配可信模型与可信输入使用。

### OCR（1）

| 工具 | 用途 |
|------|------|
| ocr_captcha | 识别 base64 验证码，用于实盘登录 |

---

## 11. 交易与风控

### 11.1 模式

| 模式 | 条件 | 行为 |
|------|------|------|
| paper | TRADE_MODE=paper，或实盘开关未全开 | 内存撮合，不下真实委托，T+1，手续费按规则计算 |
| live | TRADE_MODE=live 且 LIVE_TRADE_ENABLED=true | 通过东方财富网页交易接口提交真实委托 |
| dry-run | TRADE_DRY_RUN=true | 写类交易工具只返回预演结果，不触达交易通道 |

实盘双重开关缺一不可。即使 **TRADE_MODE=live**，只要 **LIVE_TRADE_ENABLED** 不为 true，所有交易仍按模拟盘执行。

### 11.2 风控闸

所有买卖都经过 **TradeRouter**：

| 校验 | paper | live |
|------|-------|------|
| A 股交易时段 09:25-11:30 / 13:00-15:00，周末拒绝 | 是 | 是 |
| 单笔金额上限 MAX_ORDER_AMOUNT | 是 | 是 |
| 单票仓位上限 MAX_POSITION_RATIO（买入时校验） | 是 | 是 |
| 必须提供明确限价 | 否，price=0 可用最新价 | 是 |
| ST / 退市股票拒绝 | 否 | 是 |
| 涨停封死禁买、跌停封死禁卖 | 否 | 是 |
| 卖出可用持仓校验（含 T+1） | 模拟盘内部校验 | 是 |
| 每日下单次数上限 | 否 | 是 |
| 失败写风险拦截日志（配置绑定时） | 是 | 是 |

注意：当前风控闸只放行连续竞价时段，**盘后固定价格交易（15:05-15:30）不在自动下单范围内**。策略文件中可以描述盘后操作，但自动交易会被风控拒绝。

### 11.3 模拟盘

- 初始资金由 **PAPER_INITIAL_CASH** 决定。
- 买入佣金按成交额 0.03%，最低 5 元；卖出佣金 0.04%，另加 0.1% 印花税。
- 买入手续费摊入持仓成本，卖出盈亏为扣除卖出手续费后的净额。
- T+1：当日买入不可卖，跨日后释放可用数量。
- 配置绑定时，首次启动会从平台 trades 表重放历史成交，恢复持仓与现金；未配置绑定时，重启后模拟盘状态重置。
- 成交即 filled，模拟盘没有可撤委托。

### 11.4 实盘

- 使用东方财富网页交易接口，登录需要账号密码与验证码。
- 验证码由 **ddddocr** 在本机识别，按需启动一次性 Python 进程。
- 登录态保存在 **~/.hotwave/sessions/eastmoney_trader.session**。
- 实盘委托提交后先记 **pending**，是否成交需通过委托/成交查询确认。
- 建议先用模拟盘验证策略，再开启实盘。

### 11.5 交易记录

配置绑定后，交易过程写回平台：

| 数据 | 端点 | 说明 |
|------|------|------|
| 成交记录 | POST /trades | 买卖、状态、手续费、盈亏、策略标签 |
| 执行日志 | POST /execution-logs | 成交、风控拒绝、系统事件 |
| 心跳简报 | POST /heartbeat-reports | runId、文本、token 用量、触发原因 |
| 历史成交 | GET /trades | 模拟盘重启时重放 |

鉴权使用 **X-Binding-Id / X-Binding-Secret**。写失败不会回滚已成交的交易，但会把“记录未落库”的告警返回给模型。

---

## 12. 监控、心跳与通知

### 12.1 进程内监控引擎

随网关启动，无独立进程、无端口：

- **清单**：来自 MonitorManager，默认 4 个指数，可通过 HTTP/RPC 或 MONITOR_INDEX_LIST 调整。
- **行情**：优先 server_app 的 quote 接口，失败或空结果时回落腾讯 qt.gtimg.cn。
- **判定**：涨跌幅绝对值超过 MONITOR_PRICE_PCT，或本轮量达到上轮 MONITOR_VOLUME_RATIO 倍，或触及 9.8% 涨跌停阈值。
- **告警**：同标的 60 秒冷却，广播到监控页，按通知配置推送 IM，不唤醒 LLM。
- **时段**：按本机时间推断 pre_open / morning / lunch / afternoon / idle，切换时触发一次心跳，5 分钟内同一转换点不重复触发。

监控状态可通过 **GET /monitor/status** 查看，包含 **engine** 字段：轮询次数、行情源、最近耗时、错误。

### 12.2 心跳

- 默认开启，默认间隔 10 分钟，活跃时段 09:00-15:20。
- 上一轮心跳仍在执行时跳过；距上次 LLM 不足 5 分钟且非时段切换时跳过。
- 心跳与聊天是两条独立 lane，互不中断；心跳的 LLM 调用本身串行执行，避免并发下单。
- 盘中注入 STRATEGY.md，要求模型自检模式、查资金与持仓、取行情、按策略决策。
- 每日 09:00-09:10 清空 _heartbeat_ 会话，避免跨日上下文累积。
- 简报推送到 IM，并在配置绑定时写入平台；绑定模式下若本轮失败，还会记录一条 error 简报。
- 心跳没有写死的买卖规则，所有交易决策由模型读取策略后自主完成。

调整示例：

~~~env
HOTWAVE_HEARTBEAT_INTERVAL_MS=600000
HEARTBEAT_START=09:00
HEARTBEAT_END=15:30
HEARTBEAT_MAX_TOOL_TURNS=4
~~~

### 12.3 通知路由

**NotificationRouter** 把系统消息路由到已注册渠道：

- 心跳简报按渠道配置的时段过滤。
- 监控告警按级别与类型过滤。
- 时段切换按渠道开关推送。
- 系统消息复用 chat 管道，把 sessionKey 设为 **渠道:目标 ID**，渠道的过滤逻辑自然匹配。

配置在内存中维护，渠道启动时通过 **notifications.register** 自注册，不需要配置文件。进程内渠道随运行时启动会自然恢复；以独立进程运行的渠道，在运行时重启后需要重启渠道进程以重新注册。

---

## 13. 持久化一览

| 数据 | 位置 | 是否跨重启保留 |
|------|------|----------------|
| 配置 | ~/.hotwave/.env | 是 |
| 工作区与记忆 | ~/.hotwave/workspace | 是 |
| 心跳上次触发 | 工作区/.heartbeat-state.json | 是 |
| 实盘登录态 | ~/.hotwave/sessions/eastmoney_trader.session | 是 |
| OCR 虚拟环境 | ~/.hotwave/venv | 是 |
| 对话历史 | 进程内存 | 否 |
| 模拟盘持仓与现金 | 进程内存；配置绑定时从 trades 表重放 | 视绑定而定 |
| 交易记录与简报 | 平台数据库 | 是，需绑定 |
| 通知配置 | 进程内存，由渠道自注册 | 否 |
| 运行时实例锁 | ~/.hotwave/runtime.lock | 运行时清理 |

---

## 14. 开发与测试

### 14.1 常用命令

~~~bash
pnpm install
pnpm build            # tsc 类型检查 + 编译
pnpm dev              # tsx 跑源码
pnpm start            # 跑 dist
pnpm test:integration # 全功能自测
~~~

### 14.2 自测说明

**pnpm test:integration** 覆盖：

- 内核：参数校验、超时中断、插件依赖门控、生命周期。
- 运行时 HTTP：health、state、approvals、监控订阅/上报/冷却、abort。
- 工具：9 个行情、6 个交易只读、6 个文件命令。
- 网关 RPC：connect、agent.state、monitor.status、sessions.list。
- 平台：登录、控制面、审批。
- 模型闭环：真实一次 chat/send，验证工具调用与 final。
- 监控引擎：进程内运行、取数、无 Python 瘦客户端。
- OCR：运行时自检、自画验证码识别、实盘登录识别链路。

该自测要求本机 **hotwave 运行时** 与 **server_app** 同时在线，不是纯离线单元测试。网关未启动、模型配额用尽等环境问题会按跳过处理；server_app 不可达时平台相关用例会失败。

### 14.3 扩展方式

- **新增工具**：用 **defineTool** 定义参数、输出与执行函数，在对应插件里注册到 ToolRegistry。
- **新增服务**：写一个带 **inject** 的插件，在 apply 中 **ctx.provide(name, service)**。
- **新增 RPC 方法**：在 **protocol.ts** 声明，在 **handlers.ts** 实现，并在网关方法表注册。
- **新增 IM 渠道**：实现 Channel 接口，使用 GatewayClient 连接网关，并注册通知配置。
- **替换数据源**：实现与 **fetchServerOne** 相同的接口，替换 MarketData 的 fetcher。

技术栈：TypeScript、ESM、NodeNext、strict 模式；构建产物输出到 **dist/**。

---

## 15. 排障

| 现象 | 常见原因 | 处理 |
|------|----------|------|
| 启动提示 Node 版本过低 | 命中了系统或 IDE 自带的旧 Node | nvm use 22+，或前置 nvm 的 bin 目录；pnpm dev 会自动切换 |
| 端口被占用，进程退出 | 已有实例在跑，或端口被其他程序占用 | lsof -nP -iTCP:8791 -iTCP:18789；停旧实例或 --take-over |
| 提示已有 hotwave 实例 | 实例锁或绑定锁生效 | 按提示停旧实例；由 launchd/systemd 托管时先停服务 |
| 缺少 API Key | 未配置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY | 写入 ~/.hotwave/.env 后重启 |
| 行情工具报“数据服务不可用” | server_app 未启动或 TRADE_API_BASE 不对 | 启动兼容端点，或修正 TRADE_API_BASE |
| 监控 engine.lastSource=tencent | server_app 不可用，已回落腾讯 | 检查平台服务；告警链路仍可用 |
| OCR 未就绪 | 未运行 hotwave init，或 venv 缺依赖 | hotwave init；或设置 HOTWAVE_PYTHON |
| 心跳不触发 | 不在活跃时段、上一轮仍在跑、间隔不足 | 查看 /state 的 heartbeat 字段与日志 |
| 心跳没有简报 | 模型无输出、绑定未配置、落库失败 | 看日志与平台 heartbeat_reports；先确认 binding |
| 网关 connect 失败 | Token 或 nonce 不匹配 | 检查 HOTWAVE_GW_TOKEN 与客户端配置 |
| 时间判断异常 | 进程时区不是北京时间 | 设置 TZ=Asia/Shanghai 后重启 |
| 重启后模拟盘持仓归零 | 未配置绑定，无法从 trades 表重放 | 配置 binding，或接受内存态重置 |
| 股票名称乱码 | 数据端点未按正确编码返回 | 使用 server_app 的 quote 接口，已处理编码 |

诊断入口：

~~~bash
hotwave paths
hotwave doctor
curl http://127.0.0.1:8791/health
curl http://127.0.0.1:8791/state
curl http://127.0.0.1:8791/monitor/status
~~~

---

## 16. 安全与免责

安全默认：

- HTTP 与网关默认只监听 **127.0.0.1**。需要局域网或远程访问时，显式改 HOST，并设置 **AGENT_RUNTIME_TOKEN** 与 **HOTWAVE_GW_TOKEN**。
- 网关使用 challenge-response 握手与 timing-safe Token 比较。
- 默认模拟盘；实盘需要 **TRADE_MODE=live** 与 **LIVE_TRADE_ENABLED=true** 双重开关。
- 交易写操作串行执行，避免心跳与对话并发下单。
- 文件工具限制在工作区内；但 **exec** 不是操作系统级沙箱。
- 绑定密钥只放在 **.env**，仓库已忽略 **.env** 与 **workspace/**，不要提交任何密钥或账户信息。

需要了解的风险：

- 默认 **APPROVAL_MODE=always-auto**，写类工具不产生人工确认。真正阻止实盘下单的是交易模式与风控开关，不是审批。
- 模型可能产生错误判断或幻觉，行情端点也可能返回异常数据。任何自动交易都应先在小资金或模拟盘验证。
- 提示词注入、恶意行情文本、恶意工作区文件都可能影响模型行为，请只使用可信数据源与可信插件。
- 本项目不构成投资建议，不承诺收益。市场有风险，交易需谨慎。

---

## 17. 贡献

欢迎提交 Issue 与 Pull Request。请遵守：

1. 不提交 **.env**、账户、密钥、真实交易记录或个人持仓数据。
2. 修改交易、风控、心跳相关逻辑时，说明对实盘行为的影响。
3. 新增工具或 RPC 方法时，同步更新类型、文档与自测。
4. 保持 TypeScript strict 通过，提交前运行 **pnpm build**。

问题反馈：<https://github.com/corning/hotwave/issues>

---

## 18. License

MIT License，详见 [LICENSE](LICENSE)。

Copyright (c) 2026 voocel
