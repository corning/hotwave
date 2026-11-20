/**
 * 单实例守卫（hotwave 运行时不允许多开）
 *
 * 背景：多个 hotwave 实例共用同一个 TRADE_BINDING_ID 时，hotwave_server 每个 binding 只保留
 * 最新一条反连长连接（新连接 4002 顶掉旧的），两个实例会互相顶替、无限重连，
 * 审批 / 告警 / 交易回执会在两边乱跳 —— 属于不可控状态。
 *
 * 因此运行时启动时获取两把锁：
 *   1) 实例锁  <HOTWAVE_HOME>/runtime.lock           —— 同一数据目录只允许一个运行时
 *   2) 绑定锁  <tmpdir>/hotwave-binding-<id>.lock     —— 同一 TRADE_BINDING_ID 只允许一个运行时
 *      （防 HOTWAVE_HOME / 端口各自不同、却连同一个 hotwave_server 绑定的多开）
 *
 * 已存在活实例时的处理：
 *   - 默认：打印对方 pid/端口/工作区 + 停止方式，退出码 1（不会自行接管）
 *   - 命令行加 --take-over：先停掉旧实例（launchd 管的重启由 bootout 处理），确认退出后再启动
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { hotwavePaths } from './paths.js';

export type LockInfo = {
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  gwPort: number;
  workspace: string;
  home: string;
  bindingId?: string;
};

export type LockHandle = { file: string; info: LockInfo };

const LAUNCHD_LABEL = 'com.hotwave.runtime';
const TAKE_OVER_WAIT_MS = 5_000;

function instanceLockFile(): string {
  return path.join(hotwavePaths().home, 'runtime.lock');
}

function bindingLockFile(bindingId: string): string {
  const digest = crypto.createHash('sha1').update(bindingId).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'hotwave-binding-' + digest + '.lock');
}

function readLock(file: string): LockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.pid !== 'number' || !Number.isFinite(raw.pid)) return null;
    return raw as LockInfo;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** pid 是否仍是 hotwave 运行时（防 pid 复用误判） */
function isHotwaveRuntime(pid: number): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
    return /runtime\/server\.(ts|js)/.test(args);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 旧实例是否由 launchd 托管（托管的话 kill 会被 KeepAlive 拉起，必须 bootout） */
function launchdOwns(pid: number): boolean {
  if (process.platform !== 'darwin') return false;
  const uid = process.getuid?.() ?? 0;
  try {
    const out = execFileSync('launchctl', ['print', 'gui/' + uid + '/' + LAUNCHD_LABEL], { encoding: 'utf8' });
    return new RegExp('\\bpid = ' + pid + '\\b').test(out);
  } catch {
    return false;
  }
}

function stopCommands(pid: number, hosted: boolean): string {
  const uid = process.getuid?.() ?? 0;
  const lines: string[] = [];
  if (hosted) {
    lines.push('    launchctl bootout gui/' + uid + '/' + LAUNCHD_LABEL + '   # 停掉 launchd 常驻实例');
  }
  lines.push('    kill ' + pid + '   # 结束该进程');
  return lines.join('\n');
}

/** 停掉旧实例；返回 true 表示已退出 */

/** 读取当前实例锁（供 hotwave doctor / 诊断用） */
export function currentRuntimeLock(): { info: LockInfo | null; alive: boolean } {
  const info = readLock(instanceLockFile());
  if (!info) return { info: null, alive: false };
  return { info, alive: pidAlive(info.pid) && isHotwaveRuntime(info.pid) };
}
async function stopExisting(info: LockInfo, label: string): Promise<boolean> {
  const hosted = launchdOwns(info.pid);
  if (hosted) {
    const uid = process.getuid?.() ?? 0;
    try {
      execFileSync('launchctl', ['bootout', 'gui/' + uid + '/' + LAUNCHD_LABEL], { stdio: 'ignore' });
    } catch {
      /* 未托管或已退出 */
    }
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    /* 已退出 */
  }
  const deadline = Date.now() + TAKE_OVER_WAIT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(info.pid) || !isHotwaveRuntime(info.pid)) return true;
    await sleep(200);
  }
  console.error(
    '[runtime] ' + label + ' 仍被旧实例占用（pid=' + info.pid + '），接管失败。\n  手动停止：\n' + stopCommands(info.pid, hosted),
  );
  return false;
}

/** 获取单实例锁；已存在活实例且未传 --take-over 时抛错（调用方打印后退出） */
export async function acquireRuntimeLock(
  info: LockInfo,
  opts?: { quiet?: boolean; takeOver?: boolean },
): Promise<LockHandle> {
  const takeOver = opts?.takeOver === true;
  const handles: LockHandle[] = [];
  const files: Array<{ file: string; label: string }> = [{ file: instanceLockFile(), label: '运行时实例锁（同一 HOTWAVE_HOME）' }];
  if (info.bindingId) files.push({ file: bindingLockFile(info.bindingId), label: '绑定锁（同一 TRADE_BINDING_ID）' });

  for (const { file, label } of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = readLock(file);
    if (existing && existing.pid !== process.pid && isHotwaveRuntime(existing.pid) && pidAlive(existing.pid)) {
      if (!takeOver) {
        throw new Error(
          '[runtime] 已有 hotwave 实例在运行（' + label + '）：\n' +
            '  pid=' + existing.pid + '  http=' + existing.host + ':' + existing.port + '  gateway=' + existing.gwPort + '\n' +
            '  workspace=' + existing.workspace + '\n' +
            '  startedAt=' + existing.startedAt + '\n' +
            '同一时间只允许一个实例。先停掉它：\n' + stopCommands(existing.pid, launchdOwns(existing.pid)) + '\n' +
            '或由本进程接管：<启动命令> --take-over',
        );
      }
      if (!opts?.quiet) console.warn('[runtime] 检测到旧实例 pid=' + existing.pid + '，按 --take-over 接管');
      const stopped = await stopExisting(existing, label);
      if (!stopped) throw new Error('[runtime] 接管失败：旧实例未退出');
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ ...info, startedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    handles.push({ file, info });
  }

  const cleanup = () => {
    for (const h of handles) {
      try {
        const cur = readLock(h.file);
        if (cur && cur.pid === process.pid) fs.unlinkSync(h.file);
      } catch {
        /* ignore */
      }
    }
  };
  // 只挂 exit：SIGINT/SIGTERM 由 runtime/server.ts 的 shutdown() 处理（优雅关闭后 process.exit 触发 exit）
  process.on('exit', cleanup);
  return handles[0];
}
