/**
 * #448：PMO OKR 路由两处修复
 *
 * 问题1：GET /okr 挂 30s apiCache，写操作（POST/PUT/DELETE）成功后必须失效列表缓存。
 * 问题2：每季度唯一约束撞重是客户端冲突，应返回 409（而非 500 INTERNAL_ERROR），
 *         service 层其它错误仍返回 500。
 * （STUDIO_AUTH=none 测试环境鉴权放行；数据根由 setup 隔离。）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import pmoRoutes from '../routes.js';
import { okrService } from '../okr.service.js';
import { clearCache } from '../../../middleware/api-cache.js';

let server: Server;
let baseUrl: string;

function uniqueQuarter(): string {
  return `2099-Q${Math.floor(Math.random() * 4) + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pmo', pmoRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/pmo`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await clearCache('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createOkr(quarter: string, title = 'T') {
  return fetch(`${baseUrl}/okr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyId: 'co-cache-test',
      title,
      quarter,
      objectives: [{ id: 'o1', title }],
      keyResults: [],
    }),
  });
}

describe('#448 问题1: OKR 列表缓存写后失效', () => {
  it('POST 创建后立读：缓存失效（MISS）且列表含新条目', async () => {
    const companyId = `co-inv-${Date.now()}`;
    const url = `${baseUrl}/okr?companyId=${companyId}`;

    const first = await fetch(url);
    expect(first.headers.get('x-cache')).toBe('MISS');
    const second = await fetch(url);
    expect(second.headers.get('x-cache')).toBe('HIT');

    const title = `okr-inv-${Date.now()}`;
    const post = await fetch(`${baseUrl}/okr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId, title, quarter: uniqueQuarter(),
        objectives: [{ id: 'o1', title }], keyResults: [],
      }),
    });
    expect(post.status).toBe(201);

    const after = await fetch(url);
    expect(after.headers.get('x-cache')).toBe('MISS');
    const body = (await after.json()) as { data: Array<{ title?: string }> };
    expect(JSON.stringify(body.data)).toContain(title);
  });

  it('PUT 更新后立读：缓存失效（MISS）', async () => {
    const companyId = `co-put-${Date.now()}`;
    const url = `${baseUrl}/okr?companyId=${companyId}`;
    const created = await createOkr(uniqueQuarter(), `okr-put-${Date.now()}`);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await fetch(url); // MISS，写入缓存
    const cached = await fetch(url);
    expect(cached.headers.get('x-cache')).toBe('HIT');

    const put = await fetch(`${baseUrl}/okr/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'okr-put-renamed' }),
    });
    expect(put.status).toBe(200);

    const after = await fetch(url);
    expect(after.headers.get('x-cache')).toBe('MISS');
  });

  it('DELETE 删除后立读：缓存失效（MISS）', async () => {
    const companyId = `co-del-${Date.now()}`;
    const url = `${baseUrl}/okr?companyId=${companyId}`;
    const created = await createOkr(uniqueQuarter(), `okr-del-${Date.now()}`);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await fetch(url); // MISS，写入缓存
    const cached = await fetch(url);
    expect(cached.headers.get('x-cache')).toBe('HIT');

    const del = await fetch(`${baseUrl}/okr/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await fetch(url);
    expect(after.headers.get('x-cache')).toBe('MISS');
  });
});

describe('#448 问题2: OKR 撞重返回 409', () => {
  it('同季度重复创建 → 409 CONFLICT（非 500），message 可读', async () => {
    const quarter = uniqueQuarter();
    const first = await createOkr(quarter);
    expect(first.status).toBe(201);

    const dup = await createOkr(quarter);
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('already exists');
  });

  it('service 层非冲突错误仍返回 500 INTERNAL_ERROR', async () => {
    vi.spyOn(okrService, 'create').mockRejectedValueOnce(new Error('disk exploded'));
    const res = await createOkr(uniqueQuarter());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
