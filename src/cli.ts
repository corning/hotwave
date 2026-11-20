#!/usr/bin/env node
/**
 * hotwave CLI（npm 全局安装后的入口，对应 package.json bin）
 *
 *   hotwave init      初始化 ~/.hotwave（目录 + 工作区模板 + .env 模板），幂等
 *   hotwave start     启动运行时（单进程：HTTP :8791 + 网关 :18789 + 反连 :18791 + 心跳）
 *   hotwave paths     打印路径解析结果（排障用）
 *   hotwave doctor    自检：Node 版本 / 目录 / 配置项 / 端口占用
 *   hotwave --version 版本号
 *
 * 数据目录与安装目录解耦：一切运行数据在 HOTWAVE_HOME（默认 ~/.hotwave）。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ensureHotwaveHome,
  describePaths,
  hotwavePaths,
  resolveWorkspaceDir,
  packageRoot,
} from './common/paths.js';
import { ensureOcrRuntime, ocrInfo, ocrSelftest, resolvePython } from './common/ocr.js';
import { currentRuntimeLock } from './common/instance-lock.js';

const require = createRequire(import.meta.url);

function pkgVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function printPaths(): void {
  const rows = describePaths();
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    console.log('  ' + r.name.padEnd(w) + '  ' + (r.exists ? '✓ ' : '✗ ') + r.path);
  }
  console.log('  ' + 'workdir'.padEnd(w) + '  ' + process.cwd());
}

function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function cmdInit(argv: string[]): Promise<void> {
  const noOcr = argv.includes('--no-ocr');
  const init = ensureHotwaveHome({ quiet: false });
  console.log('[init] home      ' + init.home);
  console.log('[init] workspace ' + init.workspace);
  if (init.created.length) console.log('[init] 新建目录  ' + init.created.join(', '));
  if (!init.envCreated) console.log('[init] 配置已存在，未覆盖: ' + hotwavePaths().envFile);

  // OCR（ddddocr 只有 Python 实现）：自检 + 按需建 venv 安装，无需常驻服务
  console.log('[init] OCR 运行时（仅实盘登录验证码需要，进程内调用）');
  const setup = await ensureOcrRuntime({ install: !noOcr });
  if (setup.status === 'ok' || setup.status === 'installed') {
    console.log('[init] OCR ' + (setup.status === 'ok' ? '已就绪' : '已安装') + '  python=' + setup.python +
      '  ddddocr=' + setup.ddddocr);
    if (setup.status === 'installed' && setup.detail) {
      console.log('[init] 注意：' + setup.detail + '；稍后运行 hotwave doctor 复核识别自测');
    }
  } else if (setup.status === 'skipped') {
    console.log('[init] OCR 跳过：' + setup.detail);
    console.log('[init] 需要实盘登录打码时运行: hotwave init   （或设置 HOTWAVE_PYTHON 指向已装 ddddocr 的 python）');
  } else {
    console.error('[init] OCR 未就绪（不影响行情/模拟盘）：');
    console.error('       ' + setup.detail.split('\n').join('\n       '));
  }

  console.log('[init] 下一步：编辑 ' + hotwavePaths().envFile + ' 填写 API Key，然后 hotwave start');
}

async function cmdDoctor(): Promise<void> {
  // 读配置后再自检，否则 doctor 看到的 process.env 与真实运行不一致
  await import('./common/env.js');
  console.log('hotwave ' + pkgVersion() + '  node ' + process.version);
  console.log('[paths]');
  printPaths();
  console.log('[ports]');
  for (const port of [8791, 18789]) {
    const ok = await portFree(port);
    console.log('  ' + port + '  ' + (ok ? '✓ 空闲' : '✗ 已被占用（启动会失败，需先停旧实例）'));
  }
  const envFile = hotwavePaths().envFile;
  const envExists = fs.existsSync(envFile);
  console.log('[instance]');
  const lock = currentRuntimeLock();
  if (lock.alive && lock.info) {
    console.log('  ✓ 运行中  pid=' + lock.info.pid + '  http=:' + lock.info.port + '  gateway=:' + lock.info.gwPort);
    console.log('           workspace ' + lock.info.workspace);
  } else if (lock.info) {
    console.log('  · 未运行（残留锁 pid=' + lock.info.pid + ' 已退出，下次启动会自动接管）');
  } else {
    console.log('  · 未运行（无实例锁；单实例策略下第二个进程会被拒绝）');
  }
  console.log('[env]');
  console.log('  ' + envFile + '  ' + (envExists ? '✓' : '✗ 缺失，运行 hotwave init'));
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  console.log('  API Key  ' + (hasKey ? '✓' : '✗ 未设置（ANTHROPIC_API_KEY 或 OPENAI_API_KEY）'));
  console.log('  model    ' + (process.env.HOTWAVE_MODEL || '(未设置)'));
  console.log('[ocr]');
  console.log('  模式      进程内 python worker（无端口、无常驻服务）');
  const py = resolvePython();
  console.log('  python    ' + (py ? py.cmd + '  (' + py.source + ')' : '未找到'));
  try {
    const info = await ocrInfo();
    console.log('  ddddocr   ' + info.ddddocr + '   pillow ' + info.pillow);
    const st = await ocrSelftest();
    console.log('  识别自测  ' + (st.match ? '✓ ' + st.code + ' / ' + st.elapsed + 's' : '✗ 期望 ' + st.expect + ' 实得 ' + st.code));
  } catch (e) {
    console.log('  ✗         ' + (e as Error).message.split('\n')[0]);
    console.log('            修复: hotwave init   （或 --no-ocr 跳过）');
  }
}

async function cmdStart(): Promise<void> {
  // 先建目录再加载配置：首次运行时 .env 由 init 生成，用户填完重启即生效
  ensureHotwaveHome({ quiet: true });
  await import('./common/env.js');
  await import('./runtime/server.js');
}

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

switch (cmd) {
  case 'init':
    await cmdInit(argv.slice(1));
    break;
  case 'start':
    await cmdStart();
    break;
  case 'paths':
    printPaths();
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  case '-v':
  case '--version':
  case 'version':
    console.log(pkgVersion());
    break;
  case 'help':
  case '--help':
  case '-h':
  default:
    console.log(
      [
        'hotwave ' + pkgVersion(),
        '',
        '用法: hotwave <command>',
        '',
        '  init      初始化 ~/.hotwave（工作区模板 + .env + OCR 依赖），幂等',
        '            可选 --no-ocr 跳过 ddddocr 安装',
        '  start     启动运行时（HTTP :8791 / 网关 :18789 / 反连 :18791）',
        '  paths     打印路径解析结果',
        '  doctor    自检（Node / 目录 / 配置 / 端口）',
        '',
        '环境变量: HOTWAVE_HOME   覆盖数据目录（默认 ~/.hotwave）',
        '          AGENT_WORKSPACE 覆盖工作区（默认 HOTWAVE_HOME/workspace）',
        '          HOTWAVE_PYTHON  覆盖 OCR 用的 python（默认 ~/.hotwave/venv）',
        '          HOTWAVE_PIP_INDEX 覆盖 pip 源（默认清华镜像）',
      ].join('\n'),
    );
    if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
}
