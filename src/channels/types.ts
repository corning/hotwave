/**
 * Channel 统一接口定义
 *
 * 轻量级 Channel 接口，所有 channel 实现（Telegram/飞书/钉钉/微信/App）
 * 通过统一的 start/stop/getStatus 生命周期管理和 GatewayClient RPC 连接 Agent。
 */

// ============== 统一配置 ==============

export interface ChannelConfig {
  /** Gateway WebSocket URL */
  gatewayUrl?: string;
  /** Gateway 认证 token */
  gatewayToken?: string;
  /** Channel 特有配置 */
  [key: string]: unknown;
}

// ============== 状态 ==============

export interface ChannelStatus {
  id: string;
  label: string;
  connected: boolean;
  running: boolean;
  lastEventAt?: number | null;
  lastError?: string | null;
}

// ============== Channel 接口 ==============

export interface Channel {
  readonly id: string;
  readonly label: string;

  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ChannelStatus;
}

// ============== Session 工具 ==============

/** 统一的 session key 命名规范: {channel}:{identifier} */
export function sessionKeyFor(channelId: string, identifier: string): string {
  return `${channelId}:${identifier}`;
}

/** 剥离 Markdown 标签，保留纯文本和换行（用于钉钉/飞书等不支持 Markdown 渲染的渠道） */
export function stripMarkdown(text: string): string {
  let result = text;

  // 1. 代码块：去掉围栏 ```，保留内部内容
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const lines = match.split("\n");
    lines.shift(); // 去掉开头的 ```
    if (lines.length > 0 && /^```/.test(lines[lines.length - 1]?.trim() ?? "")) {
      lines.pop(); // 去掉结尾的 ```
    }
    return lines.join("\n");
  });

  // 2. 逐行处理：标题、引用、列表、分割线
  result = result
    .split("\n")
    .map((line) => {
      // 分割线 --- / *** / ___ → 移除整行
      if (/^\s*[-*_]{3,}\s*$/.test(line)) return null;
      let l = line;
      // 标题标记 #/##/###/####/#####/######
      l = l.replace(/^#{1,6}\s+/, "");
      // 引用 >
      l = l.replace(/^>\s?/, "");
      // 无序列表 - / * / +
      l = l.replace(/^[-*+]\s+/, "");
      // 有序列表 1. / 2. / ...
      l = l.replace(/^\d+\.\s+/, "");
      return l;
    })
    .filter((l) => l !== null)
    .join("\n");

  // 3. 行内格式（顺序重要：先处理边界明确的结构，再处理通用标记）
  result = result
    .replace(/!\[.*?\]\(.*?\)/g, "[图片]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1");

  return result;
}
