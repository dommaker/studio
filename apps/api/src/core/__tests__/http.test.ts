/**
 * core/http.ts defineRoute 契约测试：
 * envelope 三形状 / zod 校验 400 / HttpError 直出 / 映射表首命中 / 500 兜底 /
 * paginated 直出 / 自定义状态码 / 204。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { dataBodySchema } from '@dommaker/studio-contract';
import { defineRoute, paginated, HttpError, requireHuman, resolveCallerAuthorType, makePagination, withStatus } from '../http.js';
import { logger } from '../../utils/logger.js';

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

  app.get('/contract-valid', defineRoute(
    { response: dataBodySchema(itemSchema) },
    async () => ({ id: '1', title: 'valid' }),
  ));

  app.get('/contract-invalid', defineRoute(
    { response: dataBodySchema(itemSchema) },
    async () => ({ id: '1', title: 42 }),
  ));

  app.get('/contract-branch', defineRoute(
    { response: dataBodySchema(itemSchema) },
    { responses: { 422: dataBodySchema(itemSchema) } },
    async () => withStatus(422, { id: '1', title: 'branch' }),
  ));

  app.get('/contract-branch-invalid', defineRoute(
    { response: dataBodySchema(itemSchema) },
    { responses: { 422: dataBodySchema(itemSchema) } },
    async () => withStatus(422, { id: '1', title: 42 }),
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
        { match: 'mapped upstream', status: 502, code: 'BAD_GATEWAY' },
      ],
    },
    async (_req, _res, input) => {
      if (input.params.id === '404') throw new Error('item not found');
      if (input.params.id === '409') throw new Error('already exists, conflict');
      if (input.params.id === '403') throw new HttpError(403, 'FORBIDDEN', 'nope');
      if (input.params.id === '500') throw new Error('boom token=fake-secret /private/internal/path');
      if (input.params.id === '501') throw new HttpError(500, 'INTERNAL', 'explicit token=fake-secret /private/internal/path');
      if (input.params.id === '502') throw new Error('mapped upstream token=fake-secret /private/internal/path');
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

  // human-only 守卫：测试用 header 模拟上游认证中间件的安全投影。
  app.use('/human-only', (req, _res, next) => {
    const actorType = req.headers['x-test-principal'];
    if (typeof actorType === 'string') (req as any).user = { id: 'principal-1', actorType };
    next();
  });
  app.post('/human-only', requireHuman('Operator action required'), defineRoute(
    { body: z.object({}).passthrough().optional() },
    async () => {
      humanSideEffects += 1;
      return { ok: true };
    },
  ));

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

  it('开发/测试环境按 response schema 校验成功响应', async () => {
    const valid = await fetch(`${base}/contract-valid`);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ data: { id: '1', title: 'valid' } });

    const invalid = await fetch(`${base}/contract-invalid`);
    expect(invalid.status).toBe(500);
    const body = await invalid.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toContain('response');
    expect(body.error.message).toContain('data.title');
  });

  it('withStatus 分支也按对应 response schema 校验', async () => {
    const valid = await fetch(`${base}/contract-branch`);
    expect(valid.status).toBe(422);
    expect(await valid.json()).toEqual({ data: { id: '1', title: 'branch' } });

    const invalid = await fetch(`${base}/contract-branch-invalid`);
    expect(invalid.status).toBe(500);
    expect((await invalid.json()).error.code).toBe('INTERNAL');
  });

  it('生产环境不因响应校验改变 5xx 收敛语义', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/contract-invalid`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: '1', title: 42 } });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
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

  it('非生产未命中映射 → 500 INTERNAL，保留诊断 message', async () => {
    const res = await fetch(`${base}/items/500`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toEqual({
      code: 'INTERNAL',
      message: 'boom token=fake-secret /private/internal/path',
    });
  });

  it('生产未处理 500 只回通用错误与 requestId，详细错误仅进日志', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/items/500`, { headers: { 'x-request-id': 'req-sec09' } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Internal server error', requestId: 'req-sec09' },
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-sec09',
          error: expect.objectContaining({ message: 'boom token=fake-secret /private/internal/path' }),
        }),
        'defineRoute: unhandled error',
      );
    } finally {
      log.mockRestore();
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });

  it('生产显式 HttpError(500) 同样只回通用错误与 requestId', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/items/501`, { headers: { 'x-request-id': 'req-sec09-http' } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Internal server error', requestId: 'req-sec09-http' },
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-sec09-http',
          error: expect.objectContaining({ message: 'explicit token=fake-secret /private/internal/path' }),
        }),
        'defineRoute: unhandled error',
      );
    } finally {
      log.mockRestore();
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });

  it('生产映射 5xx 保留状态与 code，但隐藏详细 message', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/items/502`, { headers: { 'x-request-id': 'req-sec09-mapped' } });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: { code: 'BAD_GATEWAY', message: 'Internal server error', requestId: 'req-sec09-mapped' },
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-sec09-mapped',
          error: expect.objectContaining({ message: 'mapped upstream token=fake-secret /private/internal/path' }),
        }),
        'defineRoute: unhandled error',
      );
    } finally {
      log.mockRestore();
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
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

let humanSideEffects = 0;

describe('requireHuman / resolveCallerAuthorType（认证 Principal 与业务元数据分离）', () => {
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

  const post = (init?: { body?: unknown; headers?: Record<string, string> }) =>
    fetch(`${base}/human-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  it('Operator 可执行人工动作，自声明 agent 只是业务元数据', async () => {
    const before = humanSideEffects;
    const res = await post({ headers: { 'x-test-principal': 'Operator' }, body: { authorType: 'agent' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(humanSideEffects).toBe(before + 1);
  });

  it.each(['Agent', 'System'])('%s 不能靠省略或伪造 authorType 获得 Operator 权限', async (actorType) => {
    const before = humanSideEffects;
    for (const init of [
      { headers: { 'x-test-principal': actorType } },
      { headers: { 'x-test-principal': actorType }, body: { authorType: 'human' } },
      { headers: { 'x-test-principal': actorType, 'x-author-type': 'human' } },
    ]) {
      const res = await post(init);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Operator action required' } });
    }
    expect(humanSideEffects).toBe(before);
  });

  it('没有认证 Principal 时不执行 handler', async () => {
    const before = humanSideEffects;
    const res = await post({ body: { authorType: 'human' } });
    expect(res.status).toBe(403);
    expect(humanSideEffects).toBe(before);
  });

  it('resolveCallerAuthorType：非字符串 body.authorType 忽略，缺省 human', async () => {
    const req = (body?: unknown, headers: Record<string, string> = {}) =>
      ({ body, headers }) as unknown as import('express').Request;
    expect(resolveCallerAuthorType(req({ authorType: 'agent' }, { 'x-author-type': 'human' }))).toBe('agent');
    expect(resolveCallerAuthorType(req(undefined, { 'x-author-type': 'agent' }))).toBe('agent');
    expect(resolveCallerAuthorType(req({ authorType: 123 }))).toBe('human');
    expect(resolveCallerAuthorType(req())).toBe('human');
  });
});

describe('makePagination（P2.3：收敛手搓 Math.ceil(total/limit)）', () => {
  it('字段口径与 paginated() 一致（page/limit/total 原样回显）', () => {
    expect(makePagination(3, 20, 42)).toEqual({ page: 3, limit: 20, total: 42, totalPages: 3 });
  });

  it('total=0 → totalPages 0', () => {
    expect(makePagination(1, 20, 0)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it('整除不向上虚增一页；limit>total 恒为 1 页', () => {
    expect(makePagination(1, 10, 20).totalPages).toBe(2);
    expect(makePagination(1, 100, 5).totalPages).toBe(1);
  });

  it('limit=0 透出 Infinity（收敛前 6 处手搓行为的逐项保持，非新引入语义）', () => {
    expect(makePagination(1, 0, 10).totalPages).toBe(Infinity);
    expect(makePagination(1, 0, 0).totalPages).toBe(NaN);
  });

  it('与 paginated() 组合直出分页壳', () => {
    expect(paginated([{ id: '1' }], makePagination(1, 20, 1))).toEqual({
      data: [{ id: '1' }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });
});
