/**
 * search.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 searchRoutes 到 express app，覆盖：
 * GET /search（400 缺 q / 空库 200 / apiCache 中间件命中 X-Cache: HIT）、
 * GET /resolutions（空库 200）、GET /resolution/density、
 * GET /resolution/cross-session。HOME 指向临时目录隔离真实数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let server: Server;
let base: string;

async function api(method: string, p: string): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${p}`, { method });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-search-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { searchRoutes } = await import('../search.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', searchRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('search.routes', () => {
  it('GET /search 400 without q', async () => {
    const res = await api('GET', '/search');
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('q (search query) is required');
  });

  it('GET /search 200 empty results on empty store; apiCache HIT on repeat', async () => {
    const first = await api('GET', '/search?q=anything');
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ results: [], total: 0 });
    expect(first.headers.get('x-cache')).toBe('MISS');

    const second = await api('GET', '/search?q=anything');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.json).toEqual({ results: [], total: 0 });
  });

  it('GET /resolutions 200 with empty list and byStatus', async () => {
    const res = await api('GET', '/resolutions');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ resolutions: [], total: 0, byStatus: {} });
  });

  it('GET /resolution/density 200 returns density score object', async () => {
    const res = await api('GET', '/resolution/density');
    expect(res.status).toBe(200);
    expect(typeof res.json).toBe('object');
  });

  it('GET /resolution/cross-session 200 returns stats object', async () => {
    const res = await api('GET', '/resolution/cross-session');
    expect(res.status).toBe(200);
    expect(typeof res.json).toBe('object');
  });
});
