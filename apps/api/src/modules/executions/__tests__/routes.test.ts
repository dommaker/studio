/**
 * executions 路由测试（批次 7/8 契约驱动迁移，LEGACY surface）——真 express server + fetch。
 * 钉住：GET / 分页壳形状不变 / GET /:id 裸实体进壳 + 404 / POST /events { data: { received } }。
 * executions.jsonl 在测试环境落隔离 tmp 目录（缺失 → 空列表）。
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
  app.use('/api/v1/executions', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/executions`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('executions routes（契约壳，LEGACY）', () => {
  it('GET / → 分页壳 { data: [...], pagination }（形状不变）', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.pagination).toEqual({ page: 1, limit: 20, total: json.data.length, totalPages: Math.ceil(json.data.length / 20) });
  });

  it('GET /?page=2&limit=5 分页参数透传', async () => {
    const json = await (await fetch(`${base}?page=2&limit=5`)).json();
    expect(json.pagination.page).toBe(2);
    expect(json.pagination.limit).toBe(5);
  });

  it('GET /:executionId 不存在 → 404 NOT_FOUND 错误壳', async () => {
    const res = await fetch(`${base}/no-such-execution`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('NOT_FOUND');
    expect(json.error.message).toContain('no-such-execution');
  });

  it('POST /events → { data: { received: true } }（非 workflow 事件零副作用）', async () => {
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'r-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { received: true } });
  });
});
