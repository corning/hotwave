#!/usr/bin/env node
/**
 * 开发启动器：自动挑选 >= MIN_NODE_MAJOR 的 Node 再启动项目脚本。
 *
 * 背景：macOS 上 DevEco Studio / 系统安装的 node18 常常遮蔽 nvm，
 * 导致 npm run dev 直接命中旧版本（本项目依赖 ESM 与原生模块，要求 >= 22）。
 *
 * 用法：
 *   node scripts/dev.mjs             # 启动 Agent 运行时（src/runtime/server.ts，内嵌 :18789 网关）
 *   node scripts/dev.mjs start       # 同上，跑 dist 构建产物（launchd 用）
 *   node scripts/dev.mjs --take-over # 已有实例在跑时：先停掉它（launchd 托管的先 bootout）再启动
 *
 * 工作区（Agent 读写的 SOUL/MEMORY/HEARTBEAT 等）：
 *   dev 默认用 <包根>/workspace（源码里改完即生效，方便调试；首次缺失时铺 workspace-templates）
 *   HOTWAVE_DEV_WORKSPACE=home 用 ~/.hotwave/workspace；HOTWAVE_DEV_WORKSPACE=<dir> 用指定目录
 *   AGENT_WORKSPACE 已显式设置时以它为准（一次性调试/测试用）
 *   start（launchd 常驻）不受影响，仍是 ~/.hotwave/workspace
 *
 * 选择顺序：NODE_BIN → nvm 中最高版本 → /usr/local/bin/node → /opt/homebrew/bin/node
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_MAJOR = 22;
/** 包根（hotwave/）：入口、.env、开发工作区都按它解析，不依赖当前 shell 的 pwd */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = {
  // 开发：直接用 tsx 跑 TypeScript
  runtime: { entry: 'src/runtime/server.ts', tsx: true },
  // 生产：跑 dist 构建产物
  start: { entry: 'dist/src/runtime/server.js', tsx: false },
};

const rawArgs = process.argv.slice(2);
const flags = rawArgs.filter((a) => a.startsWith('-'));
const positional = rawArgs.filter((a) => !a.startsWith('-'));
const target = positional[0] || 'runtime';
const takeOver = flags.includes('--take-over');
const spec = TARGETS[target];
if (!spec) {
  console.error('[dev] 未知目标: ' + target + '（可用: ' + Object.keys(TARGETS).join(', ') + '）');
  process.exit(1);
}
if (!fs.existsSync(path.resolve(PKG_ROOT, spec.entry))) {
  console.error('[dev] 入口不存在: ' + spec.entry);
  console.error('       开发模式请检查源码；生产模式请先执行 pnpm build');
  process.exit(1);
}

/** 展开 ~ / ~/xxx，其余按包根解析 */
const expandPath = (p) => {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(PKG_ROOT, p);
};

/**
 * dev 专用工作区解析：
 *   AGENT_WORKSPACE 已设置 → 不动（尊重显式覆盖）
 *   HOTWAVE_DEV_WORKSPACE=home → 不动（走 ~/.hotwave/workspace，与常驻一致）
 *   HOTWAVE_DEV_WORKSPACE=<dir> → 用该目录
 *   默认 → <包根>/workspace（仓库内调试，内容缺失时铺 workspace-templates）
 * 返回 { dir, note }，dir 为 null 表示不注入 AGENT_WORKSPACE。
 */
function resolveDevWorkspace() {
  const explicit = (process.env.AGENT_WORKSPACE || '').trim();
  if (explicit) return { dir: null, note: 'AGENT_WORKSPACE 已设置，沿用: ' + explicit };

  const requested = (process.env.HOTWAVE_DEV_WORKSPACE || '').trim();
  if (requested === 'home') return { dir: null, note: 'HOTWAVE_DEV_WORKSPACE=home，沿用 ~/.hotwave/workspace' };
  if (requested) return { dir: expandPath(requested), note: 'HOTWAVE_DEV_WORKSPACE=' + requested };

  return { dir: path.join(PKG_ROOT, 'workspace'), note: '开发默认（包根 workspace）' };
}

/** 是否已有 hotwave 运行时占着默认端口（dev 与常驻同跑会争抢同一 TRADE_BINDING_ID 的长连接） */
async function probeExistingRuntime() {
  const port = process.env.AGENT_RUNTIME_PORT || '8791';
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || body.service !== 'hotwave-agent-runtime') return null;
    return { port, uptimeSec: Number(body.uptimeSec) || 0 };
  } catch {
    return null;
  }
}

function seedDevWorkspace(dir) {
  if (fs.existsSync(dir)) return false;
  const templates = path.join(PKG_ROOT, 'workspace-templates');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(templates)) fs.cpSync(templates, dir, { recursive: true, force: false, errorOnExist: false });
  return true;
}

const majorOf = (bin) => {
  try {
    const v = execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim();
    return Number(v.replace(/^v/, '').split('.')[0]);
  } catch {
    return -1;
  }
};

const versionValue = (v) => {
  const [, major, minor, patch] = (v.match(/^v(\d+)\.(\d+)\.(\d+)/) || []).map(Number);
  return (major || 0) * 1e6 + (minor || 0) * 1e3 + (patch || 0);
};

function candidates() {
  const list = [];
  if (process.env.NODE_BIN) list.push(process.env.NODE_BIN);

  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    const dirs = fs
      .readdirSync(versionsDir)
      .filter((d) => /^v\d+/.test(d))
      .sort((a, b) => versionValue(b) - versionValue(a));
    for (const d of dirs) list.push(path.join(versionsDir, d, 'bin', 'node'));
  } catch {
    /* 没装 nvm 就跳过 */
  }

  list.push('/usr/local/bin/node', '/opt/homebrew/bin/node', process.execPath);
  return list;
}

const current = process.version;
const currentMajor = Number(current.replace(/^v/, '').split('.')[0]);

// 当前 Node 已达标就直接用，不做多余切换
let chosen = currentMajor >= MIN_MAJOR ? process.execPath : null;
if (!chosen) {
  for (const bin of candidates()) {
    if (!bin || !fs.existsSync(bin)) continue;
    if (bin === process.execPath) continue;
    if (majorOf(bin) >= MIN_MAJOR) {
      chosen = bin;
      break;
    }
  }
}

if (!chosen) {
  console.error(
    '[dev] 未找到 Node >= ' + MIN_MAJOR + '。\n' +
      '  请安装 nvm（https://github.com/nvm-sh/nvm）后执行：nvm install 22 && nvm use 22\n' +
      '  或设置 NODE_BIN=/path/to/node（>= 22）后重试。',
  );
  process.exit(1);
}

if (chosen !== process.execPath && currentMajor < MIN_MAJOR) {
  const v = execFileSync(chosen, ['-v'], { encoding: 'utf8' }).trim();
  console.log('[dev] 当前 Node ' + current + ' 不满足 >= ' + MIN_MAJOR + '，已自动切换到 ' + v);
}

// 透传给运行时：剩余位置参数 + 命令行开关（如 --take-over）
const passthrough = [...positional.slice(1), ...flags];
const args = spec.tsx
  ? ['--import', 'tsx', spec.entry, ...passthrough]
  : [spec.entry, ...passthrough];

// dev（tsx 跑源码）注入仓库内工作区；start（dist，launchd 形态）仍用 ~/.hotwave/workspace
const childEnv = { ...process.env };
if (spec.tsx) {
  const ws = resolveDevWorkspace();
  if (ws.dir) {
    const seeded = seedDevWorkspace(ws.dir);
    childEnv.AGENT_WORKSPACE = ws.dir;
    console.log('[dev] workspace=' + ws.dir + (seeded ? '（已从 workspace-templates 初始化）' : '') + ' — ' + ws.note);
    console.log('[dev] 常驻 launchd 仍读 ~/.hotwave/workspace；如需与线上一致：HOTWAVE_DEV_WORKSPACE=home pnpm dev');
    const alive = await probeExistingRuntime();
    if (alive) {
      console.log(
        '[dev] 注意：127.0.0.1:' + alive.port + ' 已有 hotwave 实例在跑（uptime ' + Math.round(alive.uptimeSec) + 's）。',
      );
      console.log(
        takeOver
          ? '[dev] --take-over：将先停掉旧实例（launchd 托管的先 bootout）再启动。'
          : '[dev] hotwave 只允许单实例：本次启动会被锁检查拒绝；要接管请加 --take-over。',
      );
    }
  } else {
    console.log('[dev] workspace=' + (childEnv.AGENT_WORKSPACE || '~/.hotwave/workspace') + ' — ' + ws.note);
  }
}

const child = spawn(chosen, args, { stdio: 'inherit', env: childEnv, cwd: PKG_ROOT });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
