/**
 * 用户级目录解析（HOTWAVE_HOME）
 *
 * 目标：把运行时数据从"仓库目录/当前工作目录"搬到一个与安装位置无关的用户主目录，
 * 形态对齐 dsh / claude / opencode 这类 CLI：
 *
 *   ~/.hotwave/
 *   ├── .env                配置（API Key / 交易 / 渠道）
 *   ├── workspace/          Agent 工作区（原 hotwave/workspace：SOUL.md / MEMORY.md / memory/ / .heartbeat-state.json）
 *   ├── config/             dsh-plugins.json 等结构化配置
 *   ├── sessions/           登录态（eastmoney_trader.session）
 *   ├── venv/               OCR 用的 Python 虚拟环境（ddddocr，hotwave init 创建）
 *   └── logs/               预留：常驻运行日志
 *
 * 解析优先级（workspace）：
 *   1) AGENT_WORKSPACE（显式覆盖，测试/单实例隔离用，保留不变）
 *   2) HOTWAVE_HOME/workspace
 *   3) 首次运行：若 <cwd>/workspace 存在则整目录迁移（拷贝，不改动原目录），否则铺 workspace-templates
 *
 * 解析优先级（home）：
 *   1) HOTWAVE_HOME 环境变量（支持 ~ 前缀）
 *   2) ~/.hotwave
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();

/** 展开 ~ / ~/xxx，其余按 cwd 解析 */
export function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}

/** 从模块位置向上找 package.json（name=hotwave）；源码运行与 dist 运行都成立 */
function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkgFile = path.join(dir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg?.name === 'hotwave') return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

export const packageRoot = findPackageRoot();

export type HotwavePaths = {
  home: string;
  workspace: string;
  envFile: string;
  config: string;
  sessions: string;
  venv: string;
  logs: string;
  templates: string;
  envExample: string;
};

export function hotwaveHomeDir(): string {
  const raw = process.env.HOTWAVE_HOME || process.env.HOTWAVE_CONFIG_DIR;
  return raw && raw.trim() ? expandHome(raw.trim()) : path.join(HOME, '.hotwave');
}

let cached: HotwavePaths | null = null;
let cachedHome = '';

/** 全部用户级路径（按 HOTWAVE_HOME 缓存，环境变量变化后自动失效） */
export function hotwavePaths(): HotwavePaths {
  const home = hotwaveHomeDir();
  if (cached && cachedHome === home) return cached;
  cachedHome = home;
  cached = {
    home,
    workspace: path.join(home, 'workspace'),
    envFile: path.join(home, '.env'),
    config: path.join(home, 'config'),
    sessions: path.join(home, 'sessions'),
    venv: path.join(home, 'venv'),
    logs: path.join(home, 'logs'),
    templates: path.join(packageRoot, 'workspace-templates'),
    envExample: path.join(packageRoot, '.env.example'),
  };
  return cached;
}

/** 工作区目录：AGENT_WORKSPACE 显式覆盖 → HOTWAVE_HOME/workspace */
export function resolveWorkspaceDir(): string {
  const override = process.env.AGENT_WORKSPACE;
  if (override && override.trim()) return expandHome(override.trim());
  return hotwavePaths().workspace;
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
}

export type InitResult = {
  home: string;
  workspace: string;
  created: string[];
  seededTemplates: boolean;
  migratedFrom: string | null;
  envCreated: boolean;
  envMigratedFrom: string | null;
  copiedFiles: string[];
};

/**
 * 首次运行初始化：建目录 → 迁移旧 workspace（若存在）→ 铺模板 → 生成 .env。
 * 幂等：已有内容不覆盖。
 */
export function ensureHotwaveHome(opts?: { workspaceDir?: string; quiet?: boolean; cwd?: string }): InitResult {
  const log = (msg: string) => {
    if (!opts?.quiet) console.log(msg);
  };
  const p = hotwavePaths();
  const ws = opts?.workspaceDir ?? resolveWorkspaceDir();
  const cwd = opts?.cwd ?? process.cwd();
  const created: string[] = [];

  for (const dir of [p.home, ws, p.config, p.sessions, p.logs]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  const result: InitResult = {
    home: p.home,
    workspace: ws,
    created,
    seededTemplates: false,
    migratedFrom: null,
    envCreated: false,
    envMigratedFrom: null,
    copiedFiles: [],
  };

  // 只在"用户级默认工作区"上做迁移/铺模板；显式 AGENT_WORKSPACE（测试/隔离实例）不动
  if (ws === p.workspace) {
    const marker = path.join(p.home, '.init.json');
    const legacy = path.join(cwd, 'workspace');
    const legacyIsNotHome = path.resolve(legacy) !== path.resolve(ws);

    if (isEmptyDir(ws) && legacyIsNotHome && fs.existsSync(legacy) && !isEmptyDir(legacy)) {
      copyDir(legacy, ws);
      result.migratedFrom = legacy;
      log('[paths] 已从旧工作区迁移: ' + legacy + ' -> ' + ws);
      log('[paths] 原目录保持不变（确认无误后可自行删除）');
    }

    if (isEmptyDir(ws) && fs.existsSync(p.templates)) {
      copyDir(p.templates, ws);
      result.seededTemplates = true;
      log('[paths] 已铺入工作区模板: ' + ws);
    }

    if (!fs.existsSync(marker)) {
      try {
        fs.writeFileSync(
          marker,
          JSON.stringify(
            { createdAt: new Date().toISOString(), home: p.home, workspace: ws, migratedFrom: result.migratedFrom },
            null,
            2,
          ),
        );
      } catch {
        /* ignore */
      }
    }
  }

  // 单个文件迁移：登录态 / 结构化配置（旧位置在 cwd 下，新位置在 home 下）
  const singleFiles: Array<[string, string]> = [
    [path.join(cwd, 'eastmoney_trader.session'), path.join(p.sessions, 'eastmoney_trader.session')],
    [path.join(cwd, 'config', 'dsh-plugins.json'), path.join(p.config, 'dsh-plugins.json')],
  ];
  for (const [from, to] of singleFiles) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        result.copiedFiles.push(to);
        log('[paths] 已迁移: ' + from + ' -> ' + to);
      }
    } catch {
      /* ignore */
    }
  }

  // .env：优先迁移 cwd 的真实配置，其次生成模板
  if (!fs.existsSync(p.envFile)) {
    const cwdEnv = path.join(cwd, '.env');
    const src = fs.existsSync(cwdEnv) ? cwdEnv : fs.existsSync(p.envExample) ? p.envExample : null;
    if (src) {
      try {
        fs.copyFileSync(src, p.envFile);
        try { fs.chmodSync(p.envFile, 0o600); } catch { /* ignore */ }
        result.envCreated = true;
        result.envMigratedFrom = src === cwdEnv ? cwdEnv : null;
        log(
          result.envMigratedFrom
            ? '[paths] 已迁移配置: ' + cwdEnv + ' -> ' + p.envFile
            : '[paths] 已生成配置模板: ' + p.envFile + '（请填写 API Key / 交易账号后重启）',
        );
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

/** 供 CLI / 排障输出：路径 + 是否存在 + 大小 */
export function describePaths() {
  const p = hotwavePaths();
  const ws = resolveWorkspaceDir();
  const row = (name: string, file: string) => ({
    name,
    path: file,
    exists: fs.existsSync(file),
  });
  return [
    row('hotwave home', p.home),
    row('workspace', ws),
    row('.env', p.envFile),
    row('config', p.config),
    row('sessions', p.sessions),
    row('ocr venv', p.venv),
  ];
}

/** 工作区下某个文件的绝对路径（STRATEGY.md / HEARTBEAT.md 等） */
export function workspaceFile(name: string): string {
  return path.join(resolveWorkspaceDir(), name);
}
