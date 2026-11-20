/**
 * Agent 运行时（单进程）
 *
 * 一个进程承担全部职责（旧 gateway-entry 已删除，不再有第二个进程）：
 *   - HTTP   :8791    chat/SSE、控制面、监控上报（本机 server_app 调）
 *   - 内嵌网关 :18789  WS RPC（IM 渠道 / 桌面端 / CLI）
 *   - 反连长连接 :18791 -> server_app（server_app 反向调用 trader/monitor/approval）
 *   - 心跳定时唤醒、监控告警、通知路由（NotificationRouter）
 *
 * 单进程的关键收益：交易/监控/审批只有一份实例（TradeRouter、EastMoneyTrader、
 * MonitorManager、ApprovalBridge 都是进程内单例），不会出现"网关没起 -> 实盘资产 502"。
 *
 * 端口固定：任一端口被占用即启动失败退出（不递延），保证同一时刻只有一个实例。
 */
// Node 版本守卫：项目依赖 ESM 与原生模块预编译，要求 Node >= 22。
// 常见坑：DevEco Studio / 系统自带的 node 18 会遮蔽 nvm，导致 ERR_REQUIRE_ESM。
const NODE_MAJOR = Number(process.version.replace(/^v/, '').split('.')[0]);
if (Number.isFinite(NODE_MAJOR) && NODE_MAJOR < 22) {
  console.error(
    '[runtime] Node 版本过低：当前 ' + process.version + '，需要 >= 22。\n' +
      '  常见原因：shell 命中了旧版 Node（如 DevEco Studio 自带、系统 /usr/local/bin）。\n' +
      '  处理：nvm use 22+，或把 nvm 的 bin 目录前置到 PATH 后重试。',
  );
  process.exit(1);
}
import '../common/env.js';
import { createServer } from 'node:http';
import { runAgent } from '../kernel/agent-loop.js';
import { encodeAgentEvent, doneFrame, heartbeatFrame } from '../kernel/sse.js';
import { buildRuntime } from './plugins.js';
import { runtimeState } from './state.js';
import { buildModel } from './model.js';
import { startGatewayServer } from './rpc/server.js';
import { handlers, type GwClient } from './rpc/handlers.js';
import { KernelAgent } from './kernel-agent.js';
import { ensureHotwaveHome, resolveWorkspaceDir, hotwavePaths } from '../common/paths.js';
import { acquireRuntimeLock } from '../common/instance-lock.js';
import { loadedEnvFiles } from '../common/env.js';

const PORT = Number(process.env.AGENT_RUNTIME_PORT || 8791);
const HOST = process.env.AGENT_RUNTIME_HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_RUNTIME_TOKEN || '';
const GW_PORT = Number(process.env.HOTWAVE_GW_PORT || 18789);
/** 工作区：AGENT_WORKSPACE 覆盖，否则 ~/.hotwave/workspace（见 common/paths.ts） */
const WORKSPACE = resolveWorkspaceDir();
const STARTED = Date.now();

/** 统一系统提示（HTTP chat 与内嵌网关 chat.send 共用一份，避免两套人格） */
const SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT || `你是一名专业的量化交易分析师与投资顾问，专注于 A 股市场。

## 核心原则
- 资本保全是第一纪律，风险收益比是唯一尺度
- 数据驱动，情绪隔离——让 K 线、成交量、资金流向说话
- 所有建议必须附带入场条件、止损位、目标位
- 不承诺收益，不保证准确，不参与带单/喊单

## 可用工具
- 行情: finance_kline / finance_pankou_data / finance_f10_data / finance_index_data / finance_10jqka_hot / finance_eastmoney_hot / market_anomaly / market_big_order / market_analysis
- 交易: trader_mode / trader_balance / trader_position / trader_entrust / trader_deal / trader_buy / trader_sell / trader_cancel / trader_stock_info
- 文件与命令: read / write / edit / exec / list / grep

行情数据工具优先用于回答行情相关咨询；涉及交易委托前先确认账户状态与风控规则。`;

async function readJson(req: any): Promise<any> {
  let body = '';
  req.on('data', (c: any) => (body += c));
  await new Promise((r) => req.on('end', r));
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

function json(res: any, code: number, data: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

async function main() {
  // 用户级目录首次初始化：~/.hotwave/{workspace,config,sessions} + .env 模板 + 旧 workspace 迁移
  const init = ensureHotwaveHome({ workspaceDir: WORKSPACE });
  console.log('[runtime] home=' + hotwavePaths().home + ' workspace=' + WORKSPACE);

  // 单实例守卫：同一 HOTWAVE_HOME / 同一 TRADE_BINDING_ID 只允许一个运行时。
  // 多开会共用同一 binding 反连 server_app（每个 binding 只留最新连接），互相 4002 顶掉、
  // 审批/告警/交易回执在两边乱跳；这里直接拒绝启动，而不是"带病运行"。
  // 接管旧实例：只认命令行 --take-over（不再从 .env / 环境变量读开关）
  const TAKE_OVER = process.argv.includes('--take-over');
  try {
    await acquireRuntimeLock(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: HOST,
        port: PORT,
        gwPort: GW_PORT,
        workspace: WORKSPACE,
        home: hotwavePaths().home,
        bindingId: process.env.TRADE_BINDING_ID || undefined,
      },
      { takeOver: TAKE_OVER },
    );
  } catch (e) {
    console.error(String((e as Error)?.message ?? e));
    process.exit(1);
  }
  console.log('[runtime] env=' + (loadedEnvFiles.length ? loadedEnvFiles.join(' + ') : '(无 .env，仅进程环境)'));
  if (init.migratedFrom) console.log('[runtime] 旧工作区已迁移: ' + init.migratedFrom);
  if (init.envCreated) {
    console.log(
      init.envMigratedFrom
        ? '[runtime] 配置已迁移到 ' + hotwavePaths().envFile + '（旧文件保留）'
        : '[runtime] 已生成 .env 模板，请填写后重启: ' + hotwavePaths().envFile,
    );
  }

  const runtime = await buildRuntime({ workspaceDir: WORKSPACE });
  const model = buildModel();
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    console.error('[runtime] 缺少 API Key，无法启动');
    process.exit(1);
  }
  console.log('[runtime] 工具数:', runtime.tools.length, '| 模型:', model.provider + '/' + model.id);
  console.log('[runtime] 审批策略:', (runtime.ctx.get('approvalPolicy') as any).describe());

  // 内嵌网关就绪前即可接收 HTTP 请求：状态用 let 占位，未就绪时 handler 明确报错而非抛 TDZ
  const gwClient: GwClient = {
    id: 'runtime-http',
    socket: { send: () => { }, close: () => { }, bufferedAmount: 0 },
    authed: true,
  };
  let gw: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  /** 最近一次告警纳入统计的时间（/monitor/status 契约字段） */
  let lastIngestAt: number | null = null;

  /** HTTP 入口 -> 网关 handler（同一份实现，避免监控/告警两套逻辑漂移） */
  async function callHandler(method: string, params: unknown) {
    if (!gw) {
      return { ok: false, error: { code: 'UNAVAILABLE', message: '内嵌网关尚未就绪' } } as any;
    }
    const handler = handlers[method];
    if (!handler) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'unknown method: ' + method } } as any;
    }
    try {
      return await handler(params, gwClient, gw.ctx);
    } catch (e) {
      return { ok: false, error: { code: 'UNAVAILABLE', message: String((e as Error)?.message ?? e) } } as any;
    }
  }

  // 内嵌网关所需的 Agent（心跳、chat.send 走它；HTTP chat 直接 runAgent）
  const agent = new KernelAgent({
    registry: runtime.registry,
    model,
    apiKey,
    systemPrompt: SYSTEM_PROMPT,
    agentId: 'main',
    workspaceDir: WORKSPACE,
    maxTurns: Number(process.env.AGENT_MAX_TURNS || 6),
    maxTokens: Number(process.env.AGENT_MAX_TOKENS || 8192),
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // 鉴权（本机回环且未配置 token 时放行）
    if (TOKEN && req.headers.authorization !== 'Bearer ' + TOKEN) {
      json(res, 401, { ok: false, message: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        service: 'hotwave-agent-runtime',
        engine: 'kernel',
        singleProcess: true,
        tools: runtime.tools.length,
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
      });
      return;
    }

    // ---- 控制面 ----
    if (req.method === 'GET' && url.pathname === '/state') {
      json(res, 200, runtimeState.snapshot({
        tools: runtime.tools.length,
        model: model.provider + '/' + model.id,
        heartbeat: agent.heartbeatInfo(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/chat/abort') {
      const aborted = runtimeState.abort();
      json(res, 200, { ok: true, aborted, status: runtimeState.status });
      return;
    }

    // ---- 监控：HTTP 入口直接复用网关 handler（同一份 MonitorManager，无第二份状态） ----
    if (req.method === 'GET' && url.pathname === '/monitor/status') {
      // 契约保持瘦客户端既有形状：items=数量、itemsList=列表（客户端按 itemsList 取标的）
      const s = gw ? gw.monitorManager.getStatus() : { running: false, items: 0, alertsToday: 0, uptimeMs: 0, tradingSession: 'morning' };
      const list = gw ? gw.monitorManager.getItems() : [];
      json(res, 200, {
        ...s,
        itemsList: list,
        lastIngestAt,
        // 内置监控引擎状态（替代 Python 瘦客户端）：轮询次数 / 行情源 / 最近一次耗时
        engine: gw ? gw.monitorEngine.status() : { enabled: false, intervalMs: 0, polls: 0 },
        recentAlerts: gw ? gw.monitorManager.getAlertHistory(20) : [],
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/monitor/subscribe') {
      const b = await readJson(req);
      const items = Array.isArray(b?.items) ? b.items : [];
      // HTTP 侧的 item 只带 id/symbol/name，补齐 RPC 校验所需字段
      const normalized = items.map((i: any) => ({ ...i, type: i?.type ?? 'stock', interval: i?.interval ?? 5 }));
      const r = await callHandler('monitor.subscribe', { items: normalized });
      json(res, r.ok ? 200 : 400, r.ok ? { ok: true, items: (gw?.monitorManager.getItems() ?? []).length } : { ok: false, error: r.error });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/monitor/unsubscribe') {
      const b = await readJson(req);
      const ids = Array.isArray(b?.itemIds) ? b.itemIds : [];
      const r = await callHandler('monitor.unsubscribe', { itemIds: ids });
      json(res, r.ok ? 200 : 400, r.ok ? { ok: true, items: (gw?.monitorManager.getItems() ?? []).length } : { ok: false, error: r.error });
      return;
    }

    // 瘦客户端上报的交易时段切换
    if (req.method === 'POST' && url.pathname === '/monitor/session') {
      const b = await readJson(req);
      const from = String(b?.from ?? '');
      const to = String(b?.to ?? '');
      if (!to) { json(res, 400, { ok: false, message: 'to required' }); return; }
      const r = await callHandler('monitor.instruct', { instruction: 'session_change', context: { from, to } });
      json(res, r.ok ? 200 : 500, r.ok ? { ok: true, from, to } : { ok: false, error: r.error });
      return;
    }

    // 瘦客户端上报的异动告警（冷却/去重/落最近列表/推 APP/推 IM 全在 handler 里）
    if (req.method === 'POST' && url.pathname === '/monitor/ingest') {
      const b = await readJson(req);
      const a = b?.alert;
      if (!a?.symbol) {
        json(res, 400, { ok: false, message: 'alert.symbol required' });
        return;
      }
      const metrics: Record<string, number> = {};
      if (typeof a.price === 'number') metrics.price = a.price;
      if (typeof a.changePct === 'number') metrics.changePct = a.changePct;
      const r = await callHandler('monitor.instruct', {
        instruction: 'alert',
        context: {
          level: a.severity ?? a.level ?? 'warning',
          symbol: a.symbol,
          type: 'stock',
          item: { id: a.itemId ?? a.symbol, symbol: a.symbol, type: 'stock', interval: 5 },
          metrics,
          message: a.message,
          timestamp: a.triggeredAt ?? Date.now(),
        },
      });
      const raised = r.ok ? Boolean((r.payload as any)?.raised) : false;
      if (raised) lastIngestAt = Date.now();
      json(res, r.ok ? 200 : 500, { ok: true, accepted: raised });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/approvals') {
      json(res, 200, { ok: true, items: runtimeState.approvals });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/approvals/')) {
      const id = url.pathname.slice('/approvals/'.length);
      runtimeState.approvals = runtimeState.approvals.filter((a) => a.id !== id);
      json(res, 200, { ok: true, id });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/chat/send') {
      json(res, 404, { ok: false, message: 'not found' });
      return;
    }

    let body = '';
    req.on('data', (c) => (body += c));
    await new Promise((r) => req.on('end', r));

    let parsed: any = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const content = String(parsed?.content ?? parsed?.message ?? '').trim();
    if (!content) { json(res, 400, { ok: false, message: 'content required' }); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abort = runtimeState.begin();
    res.on('close', () => abort.abort());
    const hb = setInterval(() => { try { res.write(heartbeatFrame()); } catch { /* ignore */ } }, 15_000);
    const messageId = Date.now();
    const t0 = Date.now();

    try {
      const messages = [{ role: 'user', content: [{ type: 'text', text: content }], timestamp: Date.now() }];
      const result = await runAgent({
        model,
        apiKey,
        systemPrompt: SYSTEM_PROMPT,
        registry: runtime.registry,
        messages,
        maxTurns: Number(process.env.AGENT_MAX_TURNS || 6),
        maxTokens: Number(process.env.AGENT_MAX_TOKENS || 8192),
        signal: abort.signal,
        onEvent: (e) => {
          const line = encodeAgentEvent(e);
          if (!line) return;
          try { res.write(line); } catch { /* client gone */ }
        },
      });
      if (!abort.signal.aborted) {
        try { res.write(doneFrame(messageId)); } catch { /* ignore */ }
      }
      runtimeState.end();
      console.log('[runtime] chat 完成 ' + (Date.now() - t0) + 'ms turns=' + result.turns + ' tools=' + result.toolCallCount + ' len=' + result.text.length);
    } catch (e) {
      const message = (e as Error).message;
      runtimeState.end(message);
      console.error('[runtime] chat 失败:', message);
      try {
        res.write('event: error\ndata: ' + JSON.stringify({ message }) + '\n\n');
        res.write(doneFrame(messageId));
      } catch { /* ignore */ }
    } finally {
      clearInterval(hb);
      res.end();
    }
  });

  // 端口固定：只允许一个实例。占用即失败退出（不递延），
  // 避免出现"两个实例轮流占端口、手机连到旧进程"这类难排查的状态。
  await new Promise<void>((resolve, reject) => {
    const onError = (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        console.error(
          '[runtime] 端口 ' + HOST + ':' + PORT + ' 已被占用，本进程退出（同一时间只允许一个实例）。\n' +
            '  排查占用者：lsof -nP -iTCP:' + PORT + ' -sTCP:LISTEN\n' +
            '  若占用者是 launchd 常驻服务，先停它：\n' +
            '    launchctl bootout gui/$(id -u)/com.hotpursuit.runtime',
        );
        process.exit(1);
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(PORT, HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  console.log('[runtime] listening http://' + HOST + ':' + PORT + ' (workspace=' + WORKSPACE + ')');

  // ============== 内嵌网关（同进程）==============
  // WS RPC(:18789) + 反连长连接(:18791) + MonitorManager + NotificationRouter + 心跳
  try {
    gw = await startGatewayServer({
      port: GW_PORT,
      token: process.env.HOTWAVE_GW_TOKEN,
      agent,
      monitor: process.env.MONITOR_ENABLED === 'false' ? undefined : { enabled: true },
      heartbeat: process.env.HOTWAVE_HEARTBEAT === 'false'
        ? undefined
        : {
          enabled: true,
          intervalMs: Number(process.env.HOTWAVE_HEARTBEAT_INTERVAL_MS || 600_000),
          activeHours: {
            start: process.env.HEARTBEAT_START || '09:00',
            end: process.env.HEARTBEAT_END || '15:20',
          },
        },
    });
  } catch (e) {
    const err = e as any;
    console.error(
      '[runtime] 内嵌网关监听 :' + GW_PORT + ' 失败：' + (err?.message ?? err) + '\n' +
        '  说明：网关已并入本进程，不能再单独启动 gateway。\n' +
        '  若端口被旧服务占用：launchctl bootout gui/$(id -u)/com.hotpursuit.hotwave',
    );
    process.exit(1);
  }
  console.log('[runtime] 内嵌网关 ws://127.0.0.1:' + gw.port + '（反连长连接 -> server_app 由它维护）');

  const shutdown = () => {
    try { gw?.close(); } catch { /* ignore */ }
    server.close();
    void runtime.ctx.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('[runtime] 启动失败:', e?.stack || e); process.exit(1); });
