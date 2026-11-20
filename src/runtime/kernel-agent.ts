/**
 * KernelAgent —— 让旧网关的 handlers 跑在新内核上
 *
 * 只实现 gateway/handlers.ts 与 gateway/server.ts 实际用到的 Agent 子集：
 *   run / abort / state / subscribe / getHistory / listSessions / reset / clearSession
 *   getHeartbeat
 *
 * 事件形状对齐 MiniAgentEvent（agent_start / message_delta / message_end / tool_* / agent_end），
 * 因此 server.ts 的 chat 广播逻辑无需改动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../kernel/agent-loop.js';
import type { ToolRegistry } from '../kernel/tools.js';
import { runtimeState } from './state.js';
import { resolveWorkspaceDir } from '../common/paths.js';

type Listener = (event: any) => void;

export type KernelAgentOptions = {
  registry: ToolRegistry;
  model: any;
  apiKey: string;
  systemPrompt: string;
  agentId?: string;
  maxTurns?: number;
  maxTokens?: number;
  /** 工作区（默认 AGENT_WORKSPACE / ~/.hotwave/workspace） */
  workspaceDir?: string;
};

export class KernelAgent {
  readonly agentId: string;
  private listeners = new Set<Listener>();
  private history = new Map<string, any[]>();
  private heartbeatStub = {
    updateConfig: (cfg: any) => { Object.assign(this.hbConfig, cfg ?? {}); },
    stop: () => this.stopHeartbeat(),
    start: () => undefined,
    /** 网关在时段切换点会调用它立即触发一次 */
    requestNow: (reason: string) => { void this.triggerHeartbeat(reason || 'session_change'); },
  };

  /** 工作区（心跳文档与状态文件都落在这里，与进程 cwd 无关） */
  private readonly wsDir: string;

  constructor(private opts: KernelAgentOptions) {
    this.agentId = opts.agentId ?? 'main';
    this.wsDir = opts.workspaceDir ?? resolveWorkspaceDir();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: any): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* ignore */ }
    }
  }

  async run(
    sessionKey: string,
    userMessage: string,
    opts?: { runId?: string; timeoutMs?: number; maxToolTurns?: number },
  ): Promise<any> {
    const runId = opts?.runId ?? ('run-' + Date.now());
    // 双通道：心跳用自己的 lane，不占用也不中断对话；对话反过来也不会中断心跳
    const isHeartbeatLane = sessionKey.startsWith('_heartbeat');
    const controller = isHeartbeatLane ? runtimeState.beginHeartbeat() : runtimeState.begin();
    const history = this.history.get(sessionKey) ?? [];
    const messages = [
      ...history,
      { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
    ];

    this.emit({ type: 'agent_start', runId, sessionKey, agentId: this.agentId, model: this.opts.model.id });

    let text = '';
    try {
      const result = await runAgent({
        model: this.opts.model,
        apiKey: this.opts.apiKey,
        systemPrompt: this.opts.systemPrompt,
        registry: this.opts.registry,
        messages,
        maxTurns: this.opts.maxTurns ?? 6,
        ...(opts?.maxToolTurns ? { maxToolTurns: opts.maxToolTurns } : {}),
        maxTokens: this.opts.maxTokens,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === 'delta') {
            text += e.text;
            this.emit({ type: 'message_delta', runId, sessionKey, delta: e.text });
          } else if (e.type === 'reasoning') {
            this.emit({ type: 'reasoning_delta', runId, sessionKey, delta: e.text });
          } else if (e.type === 'tool_start') {
            this.emit({ type: 'tool_execution_start', runId, sessionKey, toolCallId: e.id, toolName: e.name, args: e.args });
          } else if (e.type === 'tool_end') {
            this.emit({ type: 'tool_execution_end', runId, sessionKey, toolCallId: e.id, toolName: e.name, result: e.preview, isError: !e.ok });
          } else if (e.type === 'final') {
            this.emit({ type: 'message_end', runId, sessionKey, text: e.text, message: { role: 'assistant', content: [{ type: 'text', text: e.text }], timestamp: Date.now() } });
          }
        },
      });

      this.history.set(sessionKey, result.messages);
      if (isHeartbeatLane) runtimeState.endHeartbeat();
      else runtimeState.end();
      this.emit({ type: 'agent_end', runId, sessionKey, messages: result.messages, turns: result.turns, toolCalls: result.toolCallCount });

      return {
        runId,
        text: result.text,
        messages: result.messages,
        turns: result.turns,
        toolCalls: result.toolCallCount,
        usage: result.usage,
      };
    } catch (e) {
      const message = (e as Error).message;
      if (isHeartbeatLane) runtimeState.endHeartbeat(message);
      else runtimeState.end(message);
      this.emit({ type: 'agent_error', runId, sessionKey, error: message });
      throw e;
    }
  }

  abort(_runId?: string): void {
    runtimeState.abort();
  }

  state(_sessionKey?: string): any {
    return runtimeState.snapshot({ tools: this.opts.registry.list().length, model: this.opts.model.id });
  }

  getHistory(sessionKey: string): any[] {
    return this.history.get(sessionKey) ?? [];
  }

  async listSessions(): Promise<string[]> {
    return [...this.history.keys()];
  }

  async reset(sessionKey: string): Promise<void> {
    this.history.delete(sessionKey);
  }

  async clearSession(sessionKey: string): Promise<void> {
    this.history.delete(sessionKey);
  }

  // ============== 心跳（主动唤醒） ==============
  // 旧 heartbeat.ts 已删除。契约保持不变：
  //   updateConfig()/startHeartbeat(cb)/stop()/requestNow(reason)
  // 本类只负责"何时触发"与"读 HEARTBEAT.md"；LLM 分析、落库、路由 IM 全在回调里。
  //
  // 可观测性（为什么某轮没跑）：
  //   - 每次触发/跳过都带时间戳落日志，并把原因留在 heartbeatInfo()
  //   - 上次成功触发的时刻持久化到 .heartbeat-state.json：进程重启后按"上次+间隔"续算，
  //     不会因为频繁重启把下一次永远推到"再过 10 分钟"（这是"心跳只跑一次"的真凶之一）
  private hbConfig: { enabled: boolean; intervalMs: number; activeHours: { start: string; end: string } } = {
    enabled: false,
    intervalMs: 10 * 60 * 1000,
    activeHours: { start: '09:00', end: '16:00' },
  };
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private hbCb: ((content: string, reason: string) => Promise<any>) | null = null;
  private hbNextTickAt: number | null = null;
  private hbLastTriggerAt: number | null = null;
  private hbLastTriggerReason: string | null = null;
  private hbLastSkipReason: string | null = null;
  private hbLastRunAt: number | null = null;
  private hbLastRunMs: number | null = null;
  private hbLastHasText: boolean | null = null;
  private hbLastError: string | null = null;

  /** 读取工作区 HEARTBEAT.md（路径可用 AGENT_HEARTBEAT_FILE 覆盖） */
  private readHeartbeatDoc(): string {
    try {
      const candidates = [
        process.env.AGENT_HEARTBEAT_FILE,
        path.join(this.wsDir, 'HEARTBEAT.md'),
      ].filter(Boolean) as string[];
      for (const file of candidates) {
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
      }
      return '';
    } catch {
      return '';
    }
  }

  private inActiveHours(): boolean {
    const { start, end } = this.hbConfig.activeHours;
    const now = new Date();
    const hhmm = now.getHours() * 60 + now.getMinutes();
    const parse = (s: string) => {
      const [h, m] = s.split(':').map((x) => Number(x));
      return (h || 0) * 60 + (m || 0);
    };
    return hhmm >= parse(start) && hhmm <= parse(end);
  }

  /** 状态文件：记录上次成功触发时间，重启后按"上次+间隔"续算 */
  private hbStatePath(): string {
    if (process.env.AGENT_HEARTBEAT_STATE) return process.env.AGENT_HEARTBEAT_STATE;
    return path.join(this.wsDir, '.heartbeat-state.json');
  }

  private loadPersistedRunAt(): number | null {
    try {
      const raw = fs.readFileSync(this.hbStatePath(), 'utf8');
      const v = JSON.parse(raw);
      const ts = Number(v?.lastRunAt);
      return Number.isFinite(ts) && ts > 0 ? ts : null;
    } catch {
      return null;
    }
  }

  private persistRunAt(ts: number): void {
    try {
      const p = this.hbStatePath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ lastRunAt: ts, updatedAt: new Date().toISOString() }));
    } catch {
      /* best-effort */
    }
  }

  /** 心跳运行态快照（供 /state 与手机状态卡展示：下次何时、上次为何跳过） */
  heartbeatInfo() {
    const lane = runtimeState.hbSnapshot();
    return {
      running: lane.running,
      laneStartedAt: lane.startedAt,
      laneLastRunMs: lane.lastRunMs,
      laneLastError: lane.lastError,
      enabled: this.hbConfig.enabled,
      intervalMs: this.hbConfig.intervalMs,
      activeHours: this.hbConfig.activeHours,
      timerActive: this.hbTimer !== null,
      nextTickAt: this.hbNextTickAt,
      inActiveHours: this.inActiveHours(),
      lastTriggerAt: this.hbLastTriggerAt,
      lastTriggerReason: this.hbLastTriggerReason,
      lastSkipReason: this.hbLastSkipReason,
      lastRunAt: this.hbLastRunAt,
      lastRunMs: this.hbLastRunMs,
      lastHasText: this.hbLastHasText,
      lastError: this.hbLastError,
    };
  }

  /** 触发一次心跳回调（不在这里跑 LLM）。session_change 不受活跃时段限制。 */
  async triggerHeartbeat(reason = 'interval'): Promise<void> {
    this.hbLastTriggerAt = Date.now();
    this.hbLastTriggerReason = reason;
    this.hbLastSkipReason = null;
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log('[' + stamp + '] [heartbeat] trigger reason=' + reason + ' cb=' + (this.hbCb ? 'set' : 'null'));

    if (!this.hbCb) {
      this.hbLastSkipReason = '未注册回调';
      return;
    }
    if (reason !== 'session_change' && !this.inActiveHours()) {
      this.hbLastSkipReason = '非活跃时段 ' + this.hbConfig.activeHours.start + '-' + this.hbConfig.activeHours.end;
      console.log('[' + stamp + '] [heartbeat] 跳过：' + this.hbLastSkipReason);
      return;
    }
    // 独立 lane：只挡"上一轮心跳还在跑"，不再因为用户在聊天就让路
    if (runtimeState.hbStatus !== 'idle') {
      this.hbLastSkipReason = '上一轮心跳仍在执行';
      console.log('[' + stamp + '] [heartbeat] 跳过：' + this.hbLastSkipReason);
      return;
    }

    const t0 = Date.now();
    try {
      const r: any = await this.hbCb(this.readHeartbeatDoc(), reason);
      this.hbLastRunMs = Date.now() - t0;
      this.hbLastRunAt = Date.now();
      this.hbLastError = null;
      this.hbLastHasText = typeof r?.text === 'string' ? Boolean(r.text.trim()) : null;
      this.persistRunAt(this.hbLastRunAt);
      console.log('[' + stamp + '] [heartbeat] 完成 ' + this.hbLastRunMs + 'ms, 有文本=' + this.hbLastHasText);
    } catch (e) {
      this.hbLastRunMs = Date.now() - t0;
      this.hbLastError = (e as Error).message;
      console.warn('[' + stamp + '] [heartbeat] 回调失败：' + this.hbLastError);
    }
  }

  async startHeartbeat(cb: (content: string, reason: string) => Promise<any>, _reason = 'interval'): Promise<void> {
    this.hbCb = cb;
    if (!this.hbConfig.enabled) {
      console.log('[heartbeat] 未启用（updateConfig 未开启）');
      return;
    }
    this.stopHeartbeat();

    // 续算：上次成功触发时刻（内存优先，其次磁盘）→ 剩余时间；否则从整间隔开始
    const persisted = this.loadPersistedRunAt();
    const base = Math.max(this.hbLastRunAt ?? 0, persisted ?? 0);
    const interval = this.hbConfig.intervalMs;
    let delay = interval;
    if (base > 0) {
      const elapsed = Date.now() - base;
      // 距上次不足一个间隔 → 只等剩余时间；已逾期 → 60s 后补跑（下限 60s，避免崩溃重启时立刻打满 LLM）
      delay = elapsed < interval ? Math.max(60_000, interval - elapsed) : 60_000;
    }
    this.hbLastRunAt = base > 0 ? base : null;

    console.log(
      '[heartbeat] 已启用：每 ' + (interval / 60000).toFixed(1) + ' 分钟（' +
        this.hbConfig.activeHours.start + '-' + this.hbConfig.activeHours.end + '）；' +
        (base > 0
          ? '上次触发 ' + new Date(base).toLocaleString('zh-CN', { hour12: false }) + '，首次补跑在 ' + Math.round(delay / 1000) + 's 后'
          : '首次触发在 ' + Math.round(delay / 1000) + 's 后'),
    );
    this.scheduleTick(delay);
  }

  /** setTimeout 链式调度（避免 setInterval 与长任务重叠；每轮结束后重排下一轮） */
  private scheduleTick(delayMs: number): void {
    this.hbNextTickAt = Date.now() + delayMs;
    this.hbTimer = setTimeout(() => {
      this.hbTimer = null;
      void this.triggerHeartbeat('interval');
      // 无论触发被跳过还是失败，下一轮照常排期（问题不会自我放大）
      this.scheduleTick(this.hbConfig.intervalMs);
    }, delayMs);
  }

  stopHeartbeat(): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = null;
    this.hbNextTickAt = null;
  }

  getHeartbeat(): any {
    return this.heartbeatStub;
  }



}