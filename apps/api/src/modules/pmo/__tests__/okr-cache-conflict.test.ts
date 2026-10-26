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
import { pmoOpenRoutes, pmoWriteRoutes, pmoAdminRoutes } from '../routes.js';
import { requireAuth, requireNotGuest, requireAdmin } from '../../../middleware/auth.js';
import { getOkrService } from '../okr.service.js';
import { clearCache } from '../../../middleware/api-cache.js';

let server: Server;
let baseUrl: string;

let quarterSeq = 0;
function uniqueQuarter(): string {
  const seq = quarterSeq++;
  return `${2200 + Math.floor(seq / 4)}-Q${(seq % 4) + 1}`;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // P2-e：镜像 route-registry 挂载姿态（open 无鉴权 + write 挂 authNotGuest + admin 挂 requireAuth+requireAdmin）
  app.use('/api/v1/pmo', pmoOpenRoutes, requireAuth(), requireNotGuest(), pmoWriteRoutes, requireAdmin(), pmoAdminRoutes);
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
    // 契约驱动迁移后单体响应统一 { data } 壳（原裸对象）
    const { data: { id } } = (await created.json()) as { data: { id: string } };

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
    const { data: { id } } = (await created.json()) as { data: { id: string } };

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

  it('service 层非冲突错误仍返回 500（错误码统一 INTERNAL，原 INTERNAL_ERROR）', async () => {
    vi.spyOn(getOkrService(), 'create').mockRejectedValueOnce(new Error('disk exploded'));
    const res = await createOkr(uniqueQuarter());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL');
  });
});

describe('SEC-04 OKR quarter 严格格式', () => {
  const invalidQuarters = ['../outside', '2026-Q0', '2026-Q5', '2026-q1', '26-Q1', '2026-Q1-extra', '2026-Q1\n'];

  it('HTTP 拒绝所有非 YYYY-Qn 输入', async () => {
    for (const quarter of invalidQuarters) {
      const res = await createOkr(quarter);
      expect(res.status, JSON.stringify(quarter)).toBe(400);
    }
  });

  it('service 自身也拒绝非法 quarter，不能依赖 HTTP 校验', async () => {
    for (const quarter of invalidQuarters) {
      await expect(getOkrService().create({
        companyId: 'co-sec04',
        title: 'invalid quarter',
        quarter,
        objectives: [],
        keyResults: [],
      })).rejects.toThrow('quarter must match');
    }
  });
});
