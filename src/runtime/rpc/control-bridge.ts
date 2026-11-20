/**
 * 控制面桥接（P2）：把 Agent 的运行时控制能力暴露给远程客户端（手机 APP）。
 *
 * 覆盖三件事：
 * 1. 审批（approval）：Agent 执行敏感工具前阻塞，等远程决策；超时自动拒绝。
 * 2. 中断（abort）：由 handlers.ts 的 chat.abort 直接调 agent.abort(runId)，本模块不管。
 * 3. 状态（state）：approvals.list / 待审批数量，供 APP 展示。
 *
 * 事件上行：通过 setEventSink 注入 server-app-client 的 sendEvent，
 * 使 approval.request / approval.resolved 能经 WS 上行到 server_app，再由 SSE 推给手机。
 * 未配置 server-app-client（独立隐私模式）时 sink 为空，审批仍可在本地 CLI 完成。
 */

import type { ApprovalDecision, ApprovalRequest } from "../../common/tool-approval.js";

/** 审批超时（毫秒）：超时按"拒绝"处理，防止 Agent 永久挂起 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

type PendingApproval = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  createdAt: number;
  expiresAt: number;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ApprovalSummary = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  createdAt: number;
  expiresAt: number;
};

export class ApprovalBridge {
  private pending = new Map<string, PendingApproval>();
  private sink?: (event: string, payload: unknown) => void;

  /** 注入上行事件通道（server-app-client 连接成功后调用；断开时传 undefined） */
  setEventSink(fn?: (event: string, payload: unknown) => void): void {
    this.sink = fn;
  }

  /** 作为 Agent 的 onApprovalRequest 回调：阻塞直到远程决策或超时 */
  handle = (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const requestId = req.toolCallId + "-" + Date.now().toString(36);
    return new Promise<ApprovalDecision>((resolve) => {
      const now = Date.now();
      const entry: PendingApproval = {
        requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        createdAt: now,
        expiresAt: now + APPROVAL_TIMEOUT_MS,
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          this.sink?.("approval.resolved", { requestId, decision: "deny", reason: "timeout" });
          resolve("deny");
        }, APPROVAL_TIMEOUT_MS),
      };
      this.pending.set(requestId, entry);

      console.log("[Approval] 请求审批 requestId=" + requestId + " tool=" + req.toolName);
      this.sink?.("approval.request", {
        requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      });
    });
  };

  /** 远程决策：true 表示找到并已处理 */
  decide(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    console.log("[Approval] 决策 requestId=" + requestId + " decision=" + decision);
    this.sink?.("approval.resolved", { requestId, decision });
    return true;
  }

  /** 待审批列表（不含内部 resolve/timer） */
  list(): ApprovalSummary[] {
    return [...this.pending.values()].map((p) => ({
      requestId: p.requestId,
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      args: p.args,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    }));
  }

  get size(): number {
    return this.pending.size;
  }
}

/** 全局单例：gateway handlers 与 server-app-client 共享 */
export const approvalBridge = new ApprovalBridge();
