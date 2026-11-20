/**
 * hotwave 公开 API（package.json main 指向这里）
 *
 * 运行时数据目录：~/.hotwave（HOTWAVE_HOME 可覆盖），见 ./common/paths.js
 */

export { buildRuntime } from './runtime/plugins.js';
export type { Runtime } from './runtime/plugins.js';
export { KernelAgent } from './runtime/kernel-agent.js';
export { runAgent } from './kernel/agent-loop.js';
export { hotwavePaths, resolveWorkspaceDir, ensureHotwaveHome, workspaceFile } from './common/paths.js';
