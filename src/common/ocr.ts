/**
 * OCR（ddddocr）运行时：TS 直接 spawn Python 工作进程，不再起常驻服务
 *
 * 工作进程脚本：src/trader/captcha/worker.py（随 npm 包 src/** 分发，与交易验证码逻辑同目录）
 *
 * 为什么可以这样做：ddddocr 只有 Python 实现，但整条链路开销很小——
 * import ≈0.45s + 模型加载 ≈0.2s，一次识别 ≈0.7s；验证码只在实盘登录时出现
 * （每天一次、失败重试 1-2 次），因此"按需 spawn 一次性进程"比维护一个
 * HTTP 服务（端口、launchd、生命周期、僵尸进程）更简单可靠。
 *
 * 解释器解析顺序：
 *   1) HOTWAVE_PYTHON（显式指定，含 ~ 展开）
 *   2) HOTWAVE_HOME/venv/bin/python（hotwave init 自动创建）
 *   3) <包根>/.venv/bin/python（仓库开发 / Docker 内 /app/.venv）
 *   4) python3（PATH，兜底）
 *
 * 没有 HTTP 服务、没有端口、没有远程模式：识别就是一次本地进程调用。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, hotwavePaths, packageRoot } from './paths.js';

const WORKER = path.join(packageRoot, 'src', 'trader', 'captcha', 'worker.py');
const OCR_HINT = 'OCR 依赖未就绪：运行 `hotwave init` 安装 ddddocr，' +
  '也可设置 HOTWAVE_PYTHON 指向已装好 ddddocr 的 Python 环境';

export type PythonRuntime = { cmd: string; source: string };

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function venvPython(dir: string): string {
  return path.join(dir, 'bin', 'python');
}

/** 生成工作进程脚本路径（排障/自测用） */
export function ocrWorkerScript(): string {
  return WORKER;
}

/** 解析可用的 Python 解释器；返回 null 表示连 python3 都不在 PATH */
export function resolvePython(): PythonRuntime | null {
  const explicit = process.env.HOTWAVE_PYTHON?.trim();
  if (explicit) {
    const cmd = expandHome(explicit);
    if (isExecutable(cmd)) return { cmd, source: 'HOTWAVE_PYTHON' };
    return { cmd, source: 'HOTWAVE_PYTHON（不可执行，请检查路径）' };
  }
  const homeVenv = venvPython(hotwavePaths().venv);
  if (isExecutable(homeVenv)) return { cmd: homeVenv, source: '~/.hotwave/venv' };
  const pkgVenv = venvPython(path.join(packageRoot, '.venv'));
  if (isExecutable(pkgVenv)) return { cmd: pkgVenv, source: '<包根>/.venv' };
  return { cmd: 'python3', source: 'PATH' };
}

function cap(text: string, limit = 4096): string {
  return text.length > limit ? text.slice(-limit) : text;
}

type WorkerCall = { timeoutMs?: number; python?: PythonRuntime };

function looksLikeMissingDep(message: string): boolean {
  return /ModuleNotFoundError|No module named ('|")?(ddddocr|PIL)/i.test(message);
}

function withHint(err: Error): Error {
  if (!looksLikeMissingDep(err.message)) return err;
  return new Error(err.message + '\n' + OCR_HINT);
}

/** 调用 Python 工作进程：stdin 一行 JSON → stdout 一行 JSON */
function runWorker(payload: Record<string, unknown>, opts: WorkerCall = {}): Promise<any> {
  const rt = opts.python ?? resolvePython();
  if (!rt) return Promise.reject(new Error(OCR_HINT));
  if (!fs.existsSync(WORKER)) return Promise.reject(new Error('OCR 工作进程脚本缺失: ' + WORKER));
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (err: Error | null, val?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const child = spawn(rt.cmd, [WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => { stdout = cap(stdout + b.toString('utf8')); });
    child.stderr?.on('data', (b: Buffer) => { stderr = cap(stderr + b.toString('utf8')); });

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error('OCR 进程超时（' + timeoutMs + 'ms），可能是首次加载 ddddocr 模型较慢'));
    }, timeoutMs);

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(
        new Error(
          e.code === 'ENOENT'
            ? '找不到 Python 可执行文件: ' + rt.cmd + '（来源 ' + rt.source + '）\n' + OCR_HINT
            : 'OCR 进程启动失败: ' + e.message,
        ),
      );
    });

    child.on('close', (code) => {
      const line = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .pop();
      if (!line) {
        const diag = stderr.trim().split('\n').slice(-3).join(' | ') || '无输出';
        finish(withHint(new Error('OCR 进程异常退出（code=' + code + '）: ' + diag)));
        return;
      }
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        finish(new Error('OCR 返回非法 JSON: ' + line.slice(0, 120)));
        return;
      }
      if (!data?.ok) {
        finish(withHint(new Error('OCR 失败: ' + String(data?.error ?? 'unknown'))));
        return;
      }
      finish(null, data);
    });

    try {
      child.stdin?.end(JSON.stringify(payload) + '\n');
    } catch {
      /* close/error 事件会兜底 */
    }
  });
}

export type OcrInfo = {
  ok: boolean;
  python: string;
  executable: string;
  ddddocr: string;
  pillow: string;
  elapsed?: number;
};

/** 环境自检：解释器 + ddddocr/pillow 版本（不加载模型，约 0.3s） */
export async function ocrInfo(opts: WorkerCall = {}): Promise<OcrInfo> {
  return runWorker({ op: 'info' }, { timeoutMs: 10_000, ...opts });
}

/** 端到端自检：画一张 4 位数字验证码再识别，返回 expect/code/match/image_base64
 *  首次在新环境里加载 onnxruntime/opencv 动态库可能很慢（实测 macOS 冷启动 ~90s），超时给足 */
export async function ocrSelftest(opts: WorkerCall = {}): Promise<{
  ok: boolean;
  expect: string;
  code: string;
  match: boolean;
  image_base64: string;
  elapsed?: number;
}> {
  return runWorker({ op: 'selftest' }, { timeoutMs: 120_000, ...opts });
}

/** 识别验证码（返回识别文本，可能为空串） */
export async function ocrPredict(
  imageBase64: string,
  opts: WorkerCall & { expectedLength?: number; maxTimes?: number } = {},
): Promise<string> {
  if (!imageBase64 || typeof imageBase64 !== 'string') throw new Error('image_base64 为空');
  const data = await runWorker(
    {
      op: 'predict',
      image_base64: imageBase64,
      expected_length: opts.expectedLength ?? 4,
      max_times: opts.maxTimes ?? 5,
    },
    { timeoutMs: opts.timeoutMs ?? 90_000, python: opts.python },
  );
  return String(data?.code ?? '');
}

/** 给运行时插件/自测用的健康状态 */
export async function localOcrStatus(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const info = await ocrInfo();
    return { ok: info.ddddocr !== 'missing', detail: info.ddddocr === 'missing' ? 'ddddocr 未安装' : undefined };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 200) };
  }
}

// ---------------- 安装引导（hotwave init 调用） ----------------

type CommandResult = { code: number; tail: string };

function runCommand(cmd: string, args: string[], opts: { timeoutMs: number; quiet: boolean }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (b: Buffer) => {
      const s = b.toString('utf8');
      if (!opts.quiet && (process.stdout.isTTY || args[0] === 'install')) {
        // pip 的输出按块转发，保持进度可见
        process.stdout.write(s);
      }
      tail = (tail + s).slice(-2048);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, opts.timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: -1, tail: e.code === 'ENOENT' ? '找不到 ' + cmd : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, tail });
    });
  });
}

export type OcrSetup =
  | { status: 'ok'; python: string; source: string; ddddocr: string }
  | { status: 'installed'; python: string; ddddocr: string; detail?: string }
  | { status: 'skipped'; python: string | null; detail: string }
  | { status: 'failed'; python: string | null; detail: string };

/**
 * 自检 + 安装：已有可用环境则直接返回；否则在 HOTWAVE_HOME/venv 建虚拟环境
 * 并 pip install requirements.txt（默认清华镜像，可用 PIP_INDEX_URL 覆盖）。
 * 幂等：venv 已存在时只补装依赖。
 */
export async function ensureOcrRuntime(opts: { quiet?: boolean; install?: boolean } = {}): Promise<OcrSetup> {
  const quiet = opts.quiet ?? false;
  const log = (msg: string) => {
    if (!quiet) console.log(msg);
  };
  const rt = resolvePython();

  // 1) 现成环境可用（含已建好的 venv / 显式 HOTWAVE_PYTHON）
  if (rt) {
    try {
      const info = await ocrInfo({ python: rt });
      if (info.ddddocr !== 'missing') {
        log('[ocr] 已就绪  python=' + rt.cmd + '  ddddocr=' + info.ddddocr + '  (' + rt.source + ')');
        return { status: 'ok', python: rt.cmd, source: rt.source, ddddocr: info.ddddocr };
      }
    } catch {
      /* 继续安装 */
    }
  }

  if (opts.install === false) {
    return { status: 'skipped', python: rt?.cmd ?? null, detail: '未安装 ddddocr（已按 --no-ocr 跳过）' };
  }

  // 2) 找一个可用的基础 python 来建 venv
  const base = rt && rt.source === 'PATH' ? rt.cmd : 'python3';
  const verCheck = await runCommand(base, ['-c', 'import sys;print(sys.version.split()[0])'], {
    timeoutMs: 10_000,
    quiet: true,
  });
  if (verCheck.code !== 0) {
    return {
      status: 'failed',
      python: base,
      detail: '未找到可用的 python3（' + (verCheck.tail.trim().split('\n').pop() || '命令失败') + '）\n' + OCR_HINT,
    };
  }

  const venvDir = hotwavePaths().venv;
  const py = venvPython(venvDir);
  if (!fs.existsSync(py)) {
    log('[ocr] 创建虚拟环境: ' + venvDir + '（仅实盘登录验证码需要；下载约 100MB，占用约 500MB）');
    const created = await runCommand(base, ['-m', 'venv', venvDir], { timeoutMs: 120_000, quiet });
    if (created.code !== 0) {
      return {
        status: 'failed',
        python: base,
        detail: 'python -m venv 失败: ' + (created.tail.trim().split('\n').pop() || '未知错误') +
          '\n若系统缺少 venv 模块：Debian/Ubuntu 执行 apt install python3-venv；macOS 重装 python3。',
      };
    }
  }

  // 3) 装依赖（requirements.txt 只含 ddddocr + pillow）
  const req = path.join(packageRoot, 'requirements.txt');
  if (!fs.existsSync(req)) return { status: 'failed', python: base, detail: '依赖清单缺失: ' + req };
  const index = process.env.HOTWAVE_PIP_INDEX?.trim() || process.env.PIP_INDEX_URL?.trim() ||
    'https://pypi.tuna.tsinghua.edu.cn/simple';
  log('[ocr] 安装 Python 依赖: ddddocr（pip 源 ' + index + '，可用 Ctrl+C 中断后重试）');
  const pip = await runCommand(
    py,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req, '-i', index],
    { timeoutMs: 15 * 60_000, quiet },
  );
  if (pip.code !== 0) {
    return {
      status: 'failed',
      python: py,
      detail: 'pip install 失败: ' + (pip.tail.trim().split('\n').slice(-2).join(' ') || '未知错误') +
        '\n可手动重试: ' + py + ' -m pip install -r ' + req,
    };
  }

  // 4) 装完立即端到端验证（画验证码→识别→比对）。
  //    新环境里首次加载 onnxruntime/opencv 动态库可能非常慢（macOS 实测冷启动 1-3 分钟），
  //    故给 180s；即便超时也只降级为"已安装 + 待复核"，不把 init 判失败（依赖本身是装好的）。
  const venvRt: PythonRuntime = { cmd: py, source: '~/.hotwave/venv' };
  let info: OcrInfo;
  try {
    info = await ocrInfo({ python: venvRt });
  } catch (e) {
    return { status: 'failed', python: py, detail: '依赖已安装但无法调用（' + (e as Error).message.slice(0, 200) + '）' };
  }
  if (info.ddddocr === 'missing') {
    return { status: 'failed', python: py, detail: 'pip 安装完成后仍找不到 ddddocr，请检查 pip 输出' };
  }
  try {
    const st = await ocrSelftest({ python: venvRt, timeoutMs: 180_000 });
    if (!st.match) {
      return { status: 'installed', python: py, ddddocr: info.ddddocr,
        detail: '自测识别不一致（期望 ' + st.expect + ' / 实得 ' + st.code + '），请检查 onnxruntime 依赖' };
    }
    log('[ocr] 安装完成并通过自测  python=' + py + '  ddddocr=' + info.ddddocr);
    return { status: 'installed', python: py, ddddocr: info.ddddocr };
  } catch (e) {
    log('[ocr] 依赖已安装，首次自测未完成（新环境首次加载较慢）：' + (e as Error).message.slice(0, 120));
    return { status: 'installed', python: py, ddddocr: info.ddddocr,
      detail: '首次自测超时/失败：' + (e as Error).message.slice(0, 120) };
  }
}
