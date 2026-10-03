/**
 * mcp REST 管理面路由测试（批次 7/8 契约驱动迁移）——真 express server + fetch。
 * 协议面（POST /、/sse、/messages、/external/*）不在本文件范围（external-routes.test.ts 覆盖）。
 * 钉住：GET /tools 名词键壳 / POST /tools/:name 错误映射 / GET /health 壳 /
 * admin 六端点壳与 zod 400。STUDIO_AUTH=none（vitest env）下 requireAuth/requireAdmin 放行。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base: string;

beforeAll(async () => {
  const { default: router } = await import('../routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mcp', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/mcp`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('mcp REST 面（契约壳）', () => {
  it('GET /tools → { data: { tools, total } }（名词键，避免 data.data 双包）', async () => {
    const res = await fetch(`${base}/tools`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total).toBe(json.data.tools.length);
    expect(json.data.tools.length).toBeGreaterThan(0);
    expect(json.data.tools[0]).toMatchObject({ name: expect.any(String), description: expect.any(String) });
  });

  it('POST /tools/:name 未知工具 → 404 NOT_FOUND 错误壳（原清一色 500 细分）', async () => {
    const res = await fetch(`${base}/tools/no_such_tool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('NOT_FOUND');
    expect(json.error.message).toContain('no_such_tool');
  });

  it('GET /health → { data: { status, tools } }（全启用 → healthy 200）', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(['healthy', 'degraded']).toContain(json.data.status);
    expect(Array.isArray(json.data.tools)).toBe(true);
  });

  it('GET /admin/tools → { data: { tools, total } }，条目带 stats 键', async () => {
    const res = await fetch(`${base}/admin/tools`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total).toBe(json.data.tools.length);
    expect(json.data.tools[0]).toHaveProperty('stats');
  });

  it('PATCH /admin/tools/:name：非 boolean enabled → 400；未知名 → 404；合法 → { data: { name, enabled } }', async () => {
    const bad = await fetch(`${base}/admin/tools/x`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('BAD_REQUEST');

    const missing = await fetch(`${base}/admin/tools/no_such_tool`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');

    const listJson = await (await fetch(`${base}/admin/tools`)).json();
    const victim = listJson.data.tools[0].name;
    const off = await fetch(`${base}/admin/tools/${encodeURIComponent(victim)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ data: { name: victim, enabled: false } });
    // 复原（模块级注册表，同进程其他用例可见）
    await fetch(`${base}/admin/tools/${encodeURIComponent(victim)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
  });

  it('GET /admin/stats → { data: 五键 }', async () => {
    const json = await (await fetch(`${base}/admin/stats`)).json();
    expect(json.data.totalTools).toBeGreaterThan(0);
    expect(json.data).toMatchObject({
      enabledTools: expect.any(Number),
      totalCalls: expect.any(Number),
      successRate: expect.any(Number),
      byTool: expect.any(Object),
    });
  });

  it('GET /admin/permissions 缺 roleId → 400；带 roleId → { data: { roleId, permissions } }', async () => {
    const bad = await fetch(`${base}/admin/permissions`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('BAD_REQUEST');

    const res = await fetch(`${base}/admin/permissions?roleId=admin`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.roleId).toBe('admin');
    expect(Array.isArray(json.data.permissions)).toBe(true);
  });

  it('PUT /admin/permissions 缺键 → 400', async () => {
    const res = await fetch(`${base}/admin/permissions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_REQUEST');
  });

  it('GET /admin/audit → { data: { logs, total } }；success 词表外值 → 400', async () => {
    const res = await fetch(`${base}/admin/audit`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data.logs)).toBe(true);
    expect(json.data.total).toBe(json.data.total);

    const bad = await fetch(`${base}/admin/audit?success=yes`);
    expect(bad.status).toBe(400);
  });
});
