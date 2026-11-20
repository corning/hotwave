/**
 * AgentEvent → SSE 帧（对齐 Flutter 端现有契约）
 *
 * Flutter 期望的事件与字段（flutter_user_app/lib/src/services/chat_service.dart）：
 *   delta          { content }
 *   final          { content }
 *   done           { messageId }
 *   error          { message }
 *   thinking       { tool }
 *   thinking_done  { tool, isError }
 *   reasoning_delta{ text }
 */

import type { AgentEvent } from './agent-loop.js';

/** 一次性编码：返回应写入流的字符串（可能是空串） */
export function encodeAgentEvent(e: AgentEvent): string {
  switch (e.type) {
    case 'delta':
      return frame('delta', { content: e.text });
    case 'reasoning':
      return frame('reasoning_delta', { text: e.text });
    case 'tool_start':
      return frame('thinking', { tool: e.name });
    case 'tool_end':
      return frame('thinking_done', { tool: e.name, isError: !e.ok });
    case 'final':
      return frame('final', { content: e.text });
    case 'error':
      return frame('error', { message: e.message });
    default:
      return '';
  }
}

export function frame(event: string, data: unknown): string {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data ?? {}) + '\n\n';
}

/** 结束帧：Flutter 收到 done 后终止读取 */
export function doneFrame(messageId: number): string {
  return frame('done', { messageId });
}

/** 心跳注释帧（防中间层空闲断链） */
export function heartbeatFrame(): string {
  return ': ping\n\n';
}
