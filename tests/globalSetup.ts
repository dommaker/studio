/**
 * Vitest global setup — starts API server for E2E tests
 *
 * Spawns npx tsx apps/api/src/index.ts on port 13101,
 * waits for TCP readiness, then kills on teardown.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { resolve } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';

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

  // Ensure test DB schema is up to date — use same path as setup-db.ts
  const testDbDir = resolve(__dirname, '../apps/api/.test-data');
  try { mkdirSync(testDbDir, { recursive: true }); } catch { /* exists */ }
  const testDbPath = resolve(testDbDir, 'test.db');
  const testDbUrl = `file:${testDbPath}`;

  // Delete stale DB to avoid SQLITE_READONLY_DBMOVED
  try { unlinkSync(testDbPath); } catch { /* ignore */ }
  try { unlinkSync(testDbPath + '-journal'); } catch { /* ignore */ }
  try { unlinkSync(testDbPath + '-wal'); } catch { /* ignore */ }

  const schemaPath = resolve(__dirname, '../packages/studio-prisma/prisma/schema.prisma');
  const prismaBin = resolve(__dirname, '../node_modules/.bin/prisma');
  try {
    console.log('[globalSetup] Running prisma db push...');
    execSync(`${prismaBin} db push --force-reset --schema ${schemaPath}`, {
      cwd: resolve(__dirname, '../packages/studio-prisma'),
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe',
      timeout: 60000,
    });
    console.log('[globalSetup] Prisma db push done');
  } catch (e: unknown) {
    console.warn('[globalSetup] Prisma db push failed (non-fatal):', e instanceof Error ? e.message.slice(0, 200) : String(e));
  }

  console.log(`\n[globalSetup] Starting API server on port ${API_PORT}...`);

  serverProcess = spawn(
    'npx',
    ['tsx', 'apps/api/src/index.ts'],
    {
      env: {
        ...process.env,
        PORT: String(API_PORT),
        DATABASE_URL: testDbUrl,
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
