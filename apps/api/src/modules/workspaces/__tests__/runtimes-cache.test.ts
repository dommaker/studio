/**
 * GET /workspaces/runtimes apiCache 60s 档测试（#403，ADR 2026-08-31 决策 5）。
 *
 * 验收：60s 内二次请求不重扫（扫描子进程计数 = rescanLocalRuntimes 调用次数）。
 * 该端点每请求 execFileSync 全量重扫所有 CLI（which + --version，timeout 5s/个），
 * 同步阻塞事件循环最坏数十秒；挂 apiCache(60) 后重扫频次压到至多一次/分钟。
 *
 * auth 中间件 mock 直通（缓存 key 不含用户身份，且缓存只挂在 requireAuth 之后）；
 * rescanLocalRuntimes mock 为计数 spy；STUDIO_HOME 指向临时目录隔离 FileStore。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockRescan } = vi.hoisted(() => ({
  mockRescan: vi.fn(async () => {}),
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  requireAdmin: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  workspaceAuth: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

vi.mock('../local-workspace.js', () => ({
  rescanLocalRuntimes: mockRescan,
}));

import { clearCache } from '../../../middleware/api-cache.js';

let tmpHome = '';
let prevHome: string | undefined;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  prevHome = process.env.STUDIO_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ws-runtimes-cache-'));
  process.env.STUDIO_HOME = tmpHome;
  const { default: workspaceRoutes } = await import('../workspace.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workspaces', workspaceRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/runtimes`;
});

afterAll(async () => {
  server?.close();
  if (prevHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearCache('');
});

describe('GET /workspaces/runtimes — apiCache 60s 档（#403）', () => {
  it('60s 内二次请求不重扫：首个 MISS 触发一次 rescan，第二个 HIT 零 rescan', async () => {
    const res1 = await fetch(baseUrl);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    expect(await res1.json()).toEqual({ runtimes: [] });
    expect(mockRescan).toHaveBeenCalledTimes(1);

    const res2 = await fetch(baseUrl);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(await res2.json()).toEqual({ runtimes: [] });
    // 验收核心：第二次请求未再触发 CLI 全量重扫
    expect(mockRescan).toHaveBeenCalledTimes(1);
  });

  it('rescan 抛错不影响端点（best-effort 重扫语义不回归），响应照常入缓存', async () => {
    mockRescan.mockRejectedValueOnce(new Error('scan boom'));
    const res1 = await fetch(baseUrl);
    expect(res1.status).toBe(200);
    expect(mockRescan).toHaveBeenCalledTimes(1);

    // 错误路径本身被路由吞掉 → 响应是正常 JSON → 进缓存：二次请求 HIT 且零 rescan
    const res2 = await fetch(baseUrl);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(mockRescan).toHaveBeenCalledTimes(1);
  });
});
