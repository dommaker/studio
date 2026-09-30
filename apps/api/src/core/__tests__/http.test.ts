/**
 * core/http.ts defineRoute 契约测试：
 * envelope 三形状 / zod 校验 400 / HttpError 直出 / 映射表首命中 / 500 兜底 /
 * paginated 直出 / 自定义状态码 / 204。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { defineRoute, paginated, HttpError } from '../http.js';

const itemSchema = z.object({ id: z.string(), title: z.string() });

function buildApp() {
  const app = express();
  app.use(express.json());

  app.get('/items', defineRoute(
    { query: z.object({ q: z.string().optional() }) },
    async (_req, _res, input) => [{ id: '1', title: input.query.q ?? 'all' }],
  ));

  app.get('/items-page', defineRoute({}, async () =>
    paginated([{ id: '1' }], { page: 1, limit: 20, total: 1, totalPages: 1 }),
  ));

  app.post('/items', defineRoute(
    { body: z.object({ title: z.string().min(1) }) },
    { status: 201 },
    async (_req, _res, input) => ({ id: 'new', title: input.body.title }),
  ));

  app.get('/items/:id', defineRoute(
    { params: z.object({ id: z.string().regex(/^\d+$/) }) },
    {
      errors: [
        { match: 'not found', status: 404, code: 'NOT_FOUND' },
        { match: 'conflict', status: 409, code: 'CONFLICT' },
      ],
    },
    async (_req, _res, input) => {
      if (input.params.id === '404') throw new Error('item not found');
      if (input.params.id === '409') throw new Error('already exists, conflict');
      if (input.params.id === '403') throw new HttpError(403, 'FORBIDDEN', 'nope');
      if (input.params.id === '500') throw new Error('boom');
      return { id: input.params.id, title: 'x' };
    },
  ));

  app.delete('/items/:id', defineRoute(
    { params: z.object({ id: z.string() }) },
    { status: 204 },
    async () => undefined,
  ));

  // handler 自行写 res 的例外路径（SSE/文件流形态）
  app.get('/raw', defineRoute({}, async (_req, res) => {
    res.set('Content-Type', 'text/plain').send('raw-ok');
  }));

  return app;
}

describe('defineRoute', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('成功返回包 { data }', async () => {
    const res = await fetch(`${base}/items?q=hi`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: '1', title: 'hi' }] });
  });

  it('paginated() 直出分页壳，不再包一层', async () => {
    const res = await fetch(`${base}/items-page`);
    expect(await res.json()).toEqual({
      data: [{ id: '1' }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });

  it('body 校验失败 → 400 BAD_REQUEST，含字段路径', async () => {
    const res = await fetch(`${base}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('title');
  });

  it('body 校验通过 → 201 + { data }，input.body 是解析后的值', async () => {
    const res = await fetch(`${base}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ok' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: 'new', title: 'ok' } });
  });

  it('params 校验失败 → 400（非数字 id）', async () => {
    const res = await fetch(`${base}/items/abc`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_REQUEST');
  });

  it('映射表：not found → 404 NOT_FOUND', async () => {
    const res = await fetch(`${base}/items/404`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual({ code: 'NOT_FOUND', message: 'item not found' });
  });

  it('映射表：conflict → 409 CONFLICT', async () => {
    const res = await fetch(`${base}/items/409`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CONFLICT');
  });

  it('HttpError 直出不查表', async () => {
    const res = await fetch(`${base}/items/403`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toEqual({ code: 'FORBIDDEN', message: 'nope' });
  });

  it('未命中映射 → 500 INTERNAL', async () => {
    const res = await fetch(`${base}/items/500`);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL');
  });

  it('204 无响应体', async () => {
    const res = await fetch(`${base}/items/1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('handler 自行写 res 的例外路径不被动', async () => {
    const res = await fetch(`${base}/raw`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('raw-ok');
  });

  it('正常路径 params 校验通过', async () => {
    const res = await fetch(`${base}/items/42`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: '42', title: 'x' } });
  });
});
