/**
 * builtin-tools 路由测试（批次 7/8 契约驱动迁移）——真 express server + fetch。
 * 钉住：GET / 名词键列表壳 / GET /:name 裸实体进壳 + 404 / PATCH toggle + zod 400。
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
  app.use('/api/v1/builtin-tools', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/builtin-tools`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('builtin-tools routes（契约壳）', () => {
  it('GET / → { data: { tools, total, categories } }（名词键，避免 data.data 双包）', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total).toBe(json.data.tools.length);
    expect(json.data.tools.length).toBeGreaterThan(0);
    expect(json.data.categories).toContain('file');
    expect(json.data.tools[0]).toMatchObject({ name: expect.any(String), enabled: true });
  });

  it('GET /?category=file 只出 file 类；词表外 category → 空列表', async () => {
    const filtered = await (await fetch(`${base}?category=file`)).json();
    expect(filtered.data.tools.every((t: any) => t.category === 'file')).toBe(true);
    const empty = await (await fetch(`${base}?category=nope`)).json();
    expect(empty.data.tools).toEqual([]);
    expect(empty.data.total).toBe(0);
  });

  it('GET /:name → { data: tool }；未知名 → 404 NOT_FOUND 错误壳', async () => {
    const res = await fetch(`${base}/read_file`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('read_file');

    const missing = await fetch(`${base}/no_such_tool`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });

  it('PATCH /:name 切换 enabled → { data: tool }；非 boolean → 400；未知名 → 404', async () => {
    const off = await fetch(`${base}/notify`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect((await off.json()).data.enabled).toBe(false);
    // 复原（模块级静态数组，同进程其他用例可见）
    await fetch(`${base}/notify`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });

    const bad = await fetch(`${base}/notify`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('BAD_REQUEST');

    const missing = await fetch(`${base}/no_such_tool`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });
});
