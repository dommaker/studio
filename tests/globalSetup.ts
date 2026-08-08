/**
 * Vitest global setup — starts API server for E2E tests
 *
 * Spawns tsx apps/api/src/index.ts on port 13001,
 * waits for TCP readiness, then kills the process group on teardown.
 *
 * NOTE: 不要恢复 npx 包装层 —— npx→npm exec→sh→tsx→node 链不转发信号，
 * teardown 的信号到不了真正的 server 进程，会导致孤儿进程持有继承的
 * stdout/stderr 管道写端，vitest 主进程拿不到 EOF 而 close 超时。
 */

import { spawn, type ChildProcess } from 'child_process';
import { createConnection } from 'net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_PORT = 13001;
const STARTUP_TIMEOUT = 60000;

let serverProcess: ChildProcess | null = null;

async function waitForPort(port: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(port, '127.0.0.1');
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(new Error('timeout'));
        });
      });
      // Connected successfully — give server a moment to fully init
      await new Promise((r) => setTimeout(r, 1000));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`API server on port ${port} did not start within ${timeout}ms`);
}

// Use in-process guard so multiple workspace projects don't double-start
let isSetupCalled = false;

async function portInUse(port: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(port, '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); resolve(); });
      socket.on('error', reject);
      socket.setTimeout(500, () => { socket.destroy(); reject(new Error('timeout')); });
    });
    return true;
  } catch {
    return false;
  }
}

export async function setup() {
  // Singleton: only first caller starts
  if (isSetupCalled) return;
  isSetupCalled = true;

  if (process.env.SKIP_E2E_SERVER === 'true') return;

  // Already running (another project's globalSetup may have started it)
  if (await portInUse(API_PORT)) {
    console.log(`[globalSetup] API server already running on port ${API_PORT}`);
    return;
  }

  console.log(`\n[globalSetup] Starting API server on port ${API_PORT}...`);

  // B1 测试数据隔离：e2e server 使用独立临时数据根，禁止写生产 ~/.studio/data
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-e2e-data-'));

  serverProcess = spawn(
    // 方案 B：直接 spawn tsx，去掉 npx 包装层（npx→npm exec→sh 链不转发信号）
    path.resolve(process.cwd(), 'node_modules/.bin/tsx'),
    ['apps/api/src/index.ts'],
    {
      env: {
        ...process.env,
        PORT: String(API_PORT),
        // 覆盖 .env 中的 production 配置，确保测试 server auth bypass
        STUDIO_AUTH: 'none',
        NODE_ENV: 'test',
        STUDIO_DATA_DIR: path.join(isolatedRoot, 'data'),
        STUDIO_EVENTS_DIR: path.join(isolatedRoot, 'events'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 方案 A：独立进程组，teardown 用负 pid 杀整组，信号直达真正的 server 进程
      detached: true,
    },
  );

  serverProcess.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[api] ${data}`);
  });
  serverProcess.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[api:err] ${data}`);
  });

  serverProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[globalSetup] API server exited with code ${code}`);
    }
  });

  try {
    await waitForPort(API_PORT, STARTUP_TIMEOUT);
    console.log(`[globalSetup] API server ready on port ${API_PORT}`);
  } catch (err) {
    console.error('[globalSetup] Failed to start API server:', err);
    if (serverProcess) {
      killProcessGroup(serverProcess.pid, 'SIGKILL');
      serverProcess = null;
    }
    // Don't throw — let tests run (they'll skip/fail if no server)
  }
}

// 方案 A：向整个进程组发信号（detached: true 后子进程是组长，
// 负 pid = 组杀），绕过任何不转发信号的中间包装层。
function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // 进程组已不存在
  }
}

function waitForExit(child: ChildProcess, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let isTeardownCalled = false;

export async function teardown() {
  // Singleton teardown
  if (isTeardownCalled) return;
  isTeardownCalled = true;

  if (serverProcess) {
    console.log('\n[globalSetup] Stopping API server...');
    killProcessGroup(serverProcess.pid, 'SIGTERM');
    // server 自身有优雅关闭 + 5s 兜底，7s 内必然退出
    await waitForExit(serverProcess, 7000);
    killProcessGroup(serverProcess.pid, 'SIGKILL');
    // 主动销毁继承的管道流，确保父进程读到 EOF、句柄释放
    serverProcess.stdout?.destroy();
    serverProcess.stderr?.destroy();
    serverProcess = null;
  }
}
