/**
 * 自研 Agent Loop（本进程内，零第三方 agent 框架）
 *
 * 关键正确性：**pi-ai 用的是自己的原生消息形状**，不能沿用 hotwave 内部的
 * { role:'user', content:[{type:'tool_result',...}] } 写法：
 *   - assistant 消息直接使用 eventStream.result()（自带 api/provider/model/usage/stopReason）
 *   - 每个工具调用单独一条 { role:'toolResult', toolCallId, toolName, content:[text], isError }
 *   - 工具调用块是 { type:'toolCall', id, name, arguments }
 *
 * 事件模型（供 hotwave_server 映射 SSE）：delta / reasoning / tool_start / tool_end / final / error
 */

import { streamSimple } from '@mariozechner/pi-ai';
import type { ToolRegistry, ContentBlock } from './tools.js';

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; preview: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

export type RunAgentOptions = {
  model: any;
  apiKey: string;
  systemPrompt: string;
  registry: ToolRegistry;
  /** 历史消息（pi-ai 原生 Message） */
  messages?: any[];
  maxTurns?: number;
  /** 允许调用工具的轮次上限；超过后不再提供工具，强制模型给出结论 */
  maxToolTurns?: number;
  streamFn?: typeof streamSimple;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  maxTokens?: number;
  temperature?: number;
  /** 调试：把每轮消息打出来 */
  onTurn?: (turn: number, info: { message: any; toolCalls: Array<{ name: string; args: unknown }> }) => void;
};

export type RunAgentResult = {
  text: string;
  messages: any[];
  turns: number;
  toolCallCount: number;
  usage?: unknown;
};

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const streamFn = opts.streamFn ?? streamSimple;
  const maxTurns = opts.maxTurns ?? 8;
  const maxToolTurns = opts.maxToolTurns ?? Number.POSITIVE_INFINITY;
  let toolTurns = 0;
  const messages: any[] = [...(opts.messages ?? [])];

  let finalText = '';
  let turns = 0;
  let toolCallCount = 0;
  let lastUsage: unknown;

  for (turns = 1; turns <= maxTurns; turns++) {
    if (opts.signal?.aborted) break;

    const tools = opts.registry.schemas().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const context: any = { systemPrompt: opts.systemPrompt, messages };
    // 超过工具轮次上限后撤掉工具，并显式要求收口（避免无限取数导致空回答）
    const toolBudgetExhausted = toolTurns >= maxToolTurns;
    if (tools.length > 0 && !toolBudgetExhausted) context.tools = tools;
    if (toolBudgetExhausted) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: '工具预算已用完。请只根据上面已获得的数据直接给出结论文本，不要再请求任何工具。' }],
        timestamp: Date.now(),
      });
    }

    const streamOptions: Record<string, unknown> = { apiKey: opts.apiKey };
    if (opts.maxTokens) streamOptions.maxTokens = opts.maxTokens;
    if (opts.temperature !== undefined) streamOptions.temperature = opts.temperature;

    let eventStream: any;
    try {
      eventStream = streamFn(opts.model, context, streamOptions as any);
    } catch (e) {
      const message = (e as Error).message;
      opts.onEvent({ type: 'error', message });
      throw e;
    }

    let turnText = '';
    try {
      for await (const raw of eventStream) {
        if (opts.signal?.aborted) break;
        const event: any = raw;
        if (event?.type === 'text_delta') {
          turnText += event.delta ?? '';
          opts.onEvent({ type: 'delta', text: event.delta ?? '' });
        } else if (event?.type === 'thinking_delta') {
          opts.onEvent({ type: 'reasoning', text: event.delta ?? '' });
        } else if (event?.type === 'error') {
          const errObj = event.error;
          const message = errObj?.errorMessage ?? errObj?.message ?? 'LLM stream error';
          opts.onEvent({ type: 'error', message });
          throw new Error('LLM stream error: ' + message);
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      opts.onEvent({ type: 'error', message });
      throw e;
    }

    // 用户中断：不等待剩余流，立即返回已产生的文本
    if (opts.signal?.aborted) {
      opts.onEvent({ type: 'final', text: turnText });
      return { text: turnText, messages, turns, toolCallCount, usage: lastUsage };
    }

    // 直接取 pi-ai 的原生 assistant 消息（含 usage/stopReason/toolCall 块）
    const assistantMessage: any = await eventStream.result();
    if (!assistantMessage) throw new Error('LLM 未返回 assistant 消息');
    lastUsage = assistantMessage.usage;
    messages.push(assistantMessage);

    const toolCalls: Array<{ id: string; name: string; args: any }> = (assistantMessage.content ?? [])
      .filter((b: any) => b?.type === 'toolCall')
      .map((b: any) => ({ id: b.id, name: b.name, args: b.arguments ?? {} }));

    opts.onTurn?.(turns, { message: assistantMessage, toolCalls: toolCalls.map((c) => ({ name: c.name, args: c.args })) });

    if (toolCalls.length === 0) {
      finalText = turnText || (assistantMessage.content ?? [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('');
      opts.onEvent({ type: 'final', text: finalText });
      return { text: finalText, messages, turns, toolCallCount, usage: lastUsage };
    }

    toolTurns++;
    for (const call of toolCalls) {
      toolCallCount++;
      opts.onEvent({ type: 'tool_start', id: call.id, name: call.name, args: call.args });

      let text: string;
      let isError = false;
      try {
        const r = await opts.registry.execute(call.name, call.args, { signal: opts.signal });
        text = r.content.map((b: ContentBlock) => (b.type === 'text' ? b.text : '')).join('') || JSON.stringify(r.value);
      } catch (e) {
        isError = true;
        text = '执行错误: ' + (e as Error).message;
      }

      opts.onEvent({
        type: 'tool_end',
        id: call.id,
        name: call.name,
        ok: !isError,
        preview: text.length > 200 ? text.slice(0, 200) + '...' : text,
      });

      // pi-ai 原生 ToolResultMessage：一次调用一条
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text }],
        isError,
        timestamp: Date.now(),
      });
    }
  }

  // 收尾兜底：轮次用尽仍无文本（典型：心跳/长链路把 6 轮全用在工具调用）
  // 以前这里直接返回 text=''，上层判定"无输出"不落库 -> 表现为"心跳只跑了一次"。
  // 现在再要一次「不带工具」的结论，保证一定有可读文本。
  if (!finalText.trim()) {
    try {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: '请只根据上面已获得的数据直接给出结论文本，不要再请求任何工具。' }],
        timestamp: Date.now(),
      });
      const tailOptions: Record<string, unknown> = { apiKey: opts.apiKey };
      if (opts.maxTokens) tailOptions.maxTokens = opts.maxTokens;
      if (opts.temperature !== undefined) tailOptions.temperature = opts.temperature;
      const tailStream: any = streamFn(opts.model, { systemPrompt: opts.systemPrompt, messages }, tailOptions as any);
      let tailText = '';
      for await (const raw of tailStream) {
        const ev: any = raw;
        if (ev?.type === 'text_delta') {
          tailText += ev.delta ?? '';
          opts.onEvent({ type: 'delta', text: ev.delta ?? '' });
        } else if (ev?.type === 'thinking_delta') {
          opts.onEvent({ type: 'reasoning', text: ev.delta ?? '' });
        } else if (ev?.type === 'error') {
          throw new Error('LLM stream error: ' + (ev.error?.errorMessage ?? ev.error?.message ?? 'unknown'));
        }
      }
      const tailMsg: any = await tailStream.result();
      if (tailMsg) {
        messages.push(tailMsg);
        lastUsage = tailMsg.usage ?? lastUsage;
      }
      finalText = tailText || (tailMsg?.content ?? [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('');
      turns += 1;
    } catch (e) {
      opts.onEvent({ type: 'error', message: (e as Error).message });
    }
  }

  opts.onEvent({ type: 'final', text: finalText });
  return { text: finalText, messages, turns, toolCallCount, usage: lastUsage };
}
