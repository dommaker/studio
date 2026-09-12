/**
 * workspace.routes 只读/删除端点的真实 HTTP 级测试（#481 消假绿：
 * 取代 workspace.test.ts 的自建内存 store 自证——那批用例不 import 任何生产代码）。
 *
 * 起 express app 直打请求：
 *   GET    /api/v1/workspaces            — list（createdAt desc）
 *   GET    /api/v1/workspaces/:id        — get one / 404
 *   GET    /api/v1/workspaces/:id/runtimes — 单台 runtimes / 404
 *   DELETE /api/v1/workspaces/:id        — 删除记录 + 附属 tasks 目录 / 404
 * auth 中间件 mock 放行；local-workspace.rescanLocalRuntimes mock 为 spy（不真扫 CLI）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockRescan } = vi.hoisted(() => ({ mockRescan: vi.fn(async () => {}) }));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  requireAdmin: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

vi.mock('../local-workspace.js', () => ({ rescanLocalRuntimes: mockRescan }));

let tmpHome = '';
let prevHome: string | undefined;
let server: Server;
let baseUrl = '';
let wsDir = '';

function seedWorkspace(id: string, overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(wsDir, `${id}.json`), JSON.stringify({
    id,
    name: overrides.name ?? id,
    workspaceRoot: '/seed',
    status: 'idle',
    tokenId: null,
    runtimes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }));
}

async function call(method: string, pathSuffix: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathSuffix}`, { method });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  prevHome = process.env.STUDIO_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ws-routes-'));
  process.env.STUDIO_HOME = tmpHome;
  const { resolveWorkspacesDir } = await import('@dommaker/studio-shared/node');
  wsDir = resolveWorkspacesDir();
  fs.mkdirSync(wsDir, { recursive: true });

  const { default: workspaceRoutes } = await import('../workspace.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workspaces', workspaceRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces`;
});

afterAll(async () => {
  server?.close();
  if (prevHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { clearCache } = await import('../../../middleware/api-cache.js');
  await clearCache('');
  for (const f of fs.readdirSync(wsDir)) fs.rmSync(path.join(wsDir, f), { recursive: true, force: true });
});

describe('GET /api/v1/workspaces（list）', () => {
  it('按 createdAt desc 返回全部记录', async () => {
    seedWorkspace('ws_old', { createdAt: '2025-01-01T00:00:00.000Z' });
    seedWorkspace('ws_new', { createdAt: '2025-06-01T00:00:00.000Z' });

    const { status, body } = await call('GET', '/');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.total).toBe(2);
    expect(body.data.map((w: any) => w.id)).toEqual(['ws_new', 'ws_old']);
  });

  it('空目录 → 空列表（不报错）', async () => {
    const { status, body } = await call('GET', '/');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe('GET /api/v1/workspaces/:id（get one）', () => {
  it('返回记录原文（含 runtimes）', async () => {
    seedWorkspace('ws_1', {
      runtimes: [{ id: 'r1', provider: 'kimi', version: '0.31.0', status: 'online' }],
    });

    const { status, body } = await call('GET', '/ws_1');
    expect(status).toBe(200);
    expect(body.data.id).toBe('ws_1');
    expect(body.data.workspaceRoot).toBe('/seed');
    expect(body.data.runtimes).toHaveLength(1);
  });

  it('不存在 → 404', async () => {
    const { status, body } = await call('GET', '/ws_ghost');
    expect(status).toBe(404);
    expect(body.error).toBe('Workspace not found');
  });
});

describe('GET /api/v1/workspaces/:id/runtimes', () => {
  it('按 provider 字典序返回该记录的 runtimes', async () => {
    seedWorkspace('ws_rt', {
      runtimes: [
        { id: 'r2', provider: 'kimi', version: '0.31.0' },
        { id: 'r1', provider: 'claude', version: '2.1.80' },
      ],
    });

    const { status, body } = await call('GET', '/ws_rt/runtimes');
    expect(status).toBe(200);
    expect(body.data.map((r: any) => r.provider)).toEqual(['claude', 'kimi']);
  });

  it('不存在 → 404', async () => {
    const { status } = await call('GET', '/ws_ghost/runtimes');
    expect(status).toBe(404);
  });
});

describe('DELETE /api/v1/workspaces/:id', () => {
  it('删除记录文件与附属 tasks 目录', async () => {
    seedWorkspace('ws_del');
    // 附属 tasks 目录（events/tasks jsonl）
    const tasksDir = path.join(wsDir, 'ws_del');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'events.jsonl'), '');
    fs.writeFileSync(path.join(tasksDir, 'tasks.jsonl'), '');

    const { status, body } = await call('DELETE', '/ws_del');
    expect(status).toBe(200);
    expect(body.data).toEqual({ deleted: true });
    expect(fs.existsSync(path.join(wsDir, 'ws_del.json'))).toBe(false);
    expect(fs.existsSync(tasksDir)).toBe(false);

    // 删后 get → 404
    const after = await call('GET', '/ws_del');
    expect(after.status).toBe(404);
  });

  it('不存在 → 404', async () => {
    const { status, body } = await call('DELETE', '/ws_ghost');
    expect(status).toBe(404);
    expect(body.code).toBe('WORKSPACE_NOT_FOUND');
  });
});
