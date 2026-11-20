/**
 * 运行时控制面状态（替代旧网关的 agent.state / chat.abort / approval.*）
 *
 * 双通道（lane）设计：
 *   - chat 通道：用户对话（HTTP /chat/send）。/chat/abort 只作用于它。
 *   - heartbeat 通道：定时心跳/决策。与 chat **并行**运行、互不 abort，
 *     这样盘中聊天时定时巡检不会被丢掉（"量化拼的是时间速度"）。
 *
 * 代价与约束：两条通道会并发两个 LLM 调用，因此**下单必须串行**
 * （见 runtime/plugins/trade-tools.ts 的 trade 互斥锁），避免重复/冲突委托。
 *
 * 审批默认 always-auto，approvals 列表通常为空；保留接口以兼容手机端页面。
 */

export type RuntimeStatus = 'idle' | 'running';

export type ApprovalItem = {
  id: string;
  tool: string;
  args?: unknown;
  createdAt: number;
};

class RuntimeState {
  // ============== chat 通道 ==============
  status: RuntimeStatus = 'idle';
  startedAt: number | null = null;
  lastError: string | null = null;
  lastRunMs: number | null = null;
  controller: AbortController | null = null;
  approvals: ApprovalItem[] = [];

  // ============== heartbeat 通道（独立 lane） ==============
  hbStatus: RuntimeStatus = 'idle';
  hbStartedAt: number | null = null;
  hbLastRunMs: number | null = null;
  hbLastError: string | null = null;
  hbController: AbortController | null = null;

  /** 开始一次对话 run（只处理 chat 通道；不会中断心跳） */
  begin(): AbortController {
    if (this.status === 'running' && this.controller) {
      // 单会话串行：先中断上一个对话，避免并发破坏状态
      try { this.controller.abort(); } catch { /* ignore */ }
    }
    this.controller = new AbortController();
    this.status = 'running';
    this.startedAt = Date.now();
    this.lastError = null;
    return this.controller;
  }

  end(err?: string): void {
    this.status = 'idle';
    if (this.startedAt) this.lastRunMs = Date.now() - this.startedAt;
    this.startedAt = null;
    this.controller = null;
    if (err) this.lastError = err;
  }

  abort(): boolean {
    if (this.status !== 'running' || !this.controller) return false;
    try { this.controller.abort(); } catch { /* ignore */ }
    return true;
  }

  // ============== heartbeat 通道 ==============

  beginHeartbeat(): AbortController {
    if (this.hbStatus === 'running' && this.hbController) {
      try { this.hbController.abort(); } catch { /* ignore */ }
    }
    this.hbController = new AbortController();
    this.hbStatus = 'running';
    this.hbStartedAt = Date.now();
    this.hbLastError = null;
    return this.hbController;
  }

  endHeartbeat(err?: string): void {
    this.hbStatus = 'idle';
    if (this.hbStartedAt) this.hbLastRunMs = Date.now() - this.hbStartedAt;
    this.hbStartedAt = null;
    this.hbController = null;
    if (err) this.hbLastError = err;
  }

  abortHeartbeat(): boolean {
    if (this.hbStatus !== 'running' || !this.hbController) return false;
    try { this.hbController.abort(); } catch { /* ignore */ }
    return true;
  }

  /** 心跳通道快照（供 /state.heartbeat 叠加展示） */
  hbSnapshot() {
    return {
      running: this.hbStatus === 'running',
      startedAt: this.hbStartedAt,
      lastRunMs: this.hbLastRunMs,
      lastError: this.hbLastError,
    };
  }

  snapshot(extra: Record<string, unknown> = {}) {
    return {
      status: this.status,
      sessionKey: 'main',
      startedAt: this.startedAt,
      lastRunMs: this.lastRunMs,
      lastError: this.lastError,
      pendingApprovals: this.approvals.length,
      ...extra,
    };
  }
}

export const runtimeState = new RuntimeState();
