/**
 * 模型描述：沿用 hotwave 现有 .env（provider/model/baseUrl/key）
 */
const API_FOR_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  google: 'google-generative-ai',
};

export function buildModel() {
  const provider = process.env.HOTWAVE_PROVIDER || 'anthropic';
  const modelId = process.env.HOTWAVE_MODEL || 'deepseek-chat';
  const baseUrl = process.env.HOTWAVE_BASE_URL || '';
  return {
    id: modelId,
    name: modelId,
    api: API_FOR_PROVIDER[provider] || 'anthropic-messages',
    provider,
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: Number(process.env.AGENT_MAX_TOKENS || 8192),
    headers: {
      'User-Agent': null,
      'X-Stainless-Lang': null,
      'X-Stainless-Package-Version': null,
      'X-Stainless-OS': null,
      'X-Stainless-Arch': null,
      'X-Stainless-Runtime': null,
      'X-Stainless-Runtime-Version': null,
      'anthropic-dangerous-direct-browser-access': null,
      'anthropic-beta': null,
    },
    compat: { supportsDeveloperRole: !['dashscope', 'deepseek'].some((n) => baseUrl.includes(n)) },
  };
}
