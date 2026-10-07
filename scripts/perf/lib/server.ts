/**
 * 隔离起服（#673）——复刻 performance-baseline.md §2 方法：
 * mkdtemp STUDIO_HOME（全程不碰默认数据根）+ 空闲端口 + STUDIO_AUTH=none
 * + node 直跑 tsx cli 起 `apps/api/src/index.ts`（与生产同形态，tsx 运行时转译；
 * 不经 npx 壳——本机 earlyoom --avoid 名单只含 "node" comm，npm 壳会被优先杀）。
 * 冷启动口径 = 进程 spawn → /api/v1/health 首次 200（50ms 轮询）；
 * /readyz 首次 200 = 全量就绪（listen 前移后两口径分离，见 baseline §7）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// 直接 node 跑 tsx cli，不经 npx/npm 壳：① 少两层派生，停服干净；
// ② 进程 comm = "node"，命中本机 earlyoom --avoid 名单（"npm exec" 壳不在名单内会被优先杀）
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export interface ServerHandle {
  proc: ChildProcess;
  port: number;
  studioHome: string;
  baseUrl: string;
  /** 端口可服务耗时（spawn → /health 首次 200），ms */
  coldStartMs: number;
}

export function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'studio-perf-'));
}

export function removeTempHome(home: string): void {
  if (home.includes('studio-perf-')) rmSync(home, { recursive: true, force: true });
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

async function pollUntil200(url: string, timeoutMs: number, proc: ChildProcess): Promise<number> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`API 进程提前退出（code=${proc.exitCode}）`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return Date.now() - start;
    } catch {
      // 端口未开，继续轮询
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${url} 200 超时（${timeoutMs}ms）`);
}

export interface StartOptions {
  studioHome?: string;
  timeoutMs?: number;
  /** 追加环境变量（#674 LCP 测量需要 REGISTER_ENABLED=true 造已认证用户） */
  extraEnv?: Record<string, string>;
}

export async function startServer(opts: StartOptions = {}): Promise<ServerHandle> {
  const studioHome = opts.studioHome ?? makeTempHome();
  const port = await findFreePort();
  const proc = spawn(process.execPath, [tsxCli, 'apps/api/src/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STUDIO_HOME: studioHome,
      PORT: String(port),
      STUDIO_AUTH: 'none',
      NODE_ENV: 'production',
      ...opts.extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立进程组：npx→tsx→node 三层派生，停服须杀整个组，否则孙进程成孤儿
    detached: true,
  });
  proc.stdout?.resume(); // 排空管道防缓冲写满阻塞
  proc.stderr?.resume();
  const baseUrl = `http://127.0.0.1:${port}`;
  const coldStartMs = await pollUntil200(`${baseUrl}/api/v1/health`, opts.timeoutMs ?? 180_000, proc);
  return { proc, port, studioHome, baseUrl, coldStartMs };
}

/** 全量就绪：/readyz 首次 200（bootstrap 链尾 markReady 才 200，baseline §7.2） */
export async function waitReady(handle: ServerHandle, timeoutMs = 180_000): Promise<number> {
  return pollUntil200(`${handle.baseUrl}/readyz`, timeoutMs, handle.proc);
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal); // 整个进程组（detached 组组长 = 直接子进程）
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // 已退出
    }
  }
}

export async function stopServer(handle: ServerHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  killGroup(proc, 'SIGTERM');
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  await Promise.race([exited, timeout]);
  killGroup(proc, 'SIGKILL');
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
}
