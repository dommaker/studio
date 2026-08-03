/**
 * Vitest global setup — starts API server for E2E tests
 *
 * Spawns npx tsx apps/api/src/index.ts on port 13101,
 * waits for TCP readiness, then kills on teardown.
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
    'npx',
    ['tsx', 'apps/api/src/index.ts'],
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
      detached: false,
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
      serverProcess.kill('SIGTERM');
      serverProcess = null;
    }
    // Don't throw — let tests run (they'll skip/fail if no server)
  }
}

let isTeardownCalled = false;

export async function teardown() {
  // Singleton teardown
  if (isTeardownCalled) return;
  isTeardownCalled = true;

  if (serverProcess) {
    console.log('\n[globalSetup] Stopping API server...');
    serverProcess.kill('SIGTERM');
    // Give it a moment to clean up
    await new Promise((r) => setTimeout(r, 2000));
    try {
      serverProcess.kill('SIGKILL');
    } catch {
      // Already dead
    }
    serverProcess = null;
  }
}
