/**
 * 传输层与内核之间的契约类型
 *
 * 旧 agent.ts 已删除；网关只依赖这些结构，不依赖具体实现。
 */
export type AgentLike = {
  agentId?: string;
  run(
    sessionKey: string,
    message: string,
    opts?: { runId?: string; timeoutMs?: number; maxToolTurns?: number },
  ): Promise<any>;
  abort(runId?: string): void;
  state(sessionKey?: string): any;
  subscribe(fn: (event: any) => void): () => void;
  getHistory(sessionKey: string): any[];
  listSessions(): Promise<string[]>;
  reset(sessionKey: string): Promise<void>;
  clearSession(sessionKey: string): Promise<void>;
  getHeartbeat(): any;
  startHeartbeat?(cb: any, reason?: string): Promise<void>;
  stopHeartbeat?(): void;
};
