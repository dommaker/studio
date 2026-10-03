/**
 * lark / dingtalk 路由测试（批次 7/8 契约驱动迁移）——真 express server + fetch。
 * 回调面（lark /callback、dingtalk /action）为协议例外保持原样，此处只钉：
 * - GET /health 两域统一 { data } 壳
 * - lark /callback 未配置 token → fail-closed 503（回归，协议面不受迁移影响）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base: string;
let prevToken: string | undefined;

beforeAll(async () => {
  prevToken = process.env.LARK_VERIFICATION_TOKEN;
  delete process.env.LARK_VERIFICATION_TOKEN;

  const { default: larkRoutes } = await import('../routes.js');
  const { default: dingtalkRoutes } = await import('../../dingtalk/routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/lark', larkRoutes);
  app.use('/api/v1/dingtalk', dingtalkRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (prevToken === undefined) delete process.env.LARK_VERIFICATION_TOKEN;
  else process.env.LARK_VERIFICATION_TOKEN = prevToken;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('lark routes', () => {
  it('GET /health → { data: { status, service } }（统一壳）', async () => {
    const res = await fetch(`${base}/api/v1/lark/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'ok', service: 'lark-callback' } });
  });

  it('POST /callback 未配置 token → fail-closed 503（协议面，非错误壳）', async () => {
    const res = await fetch(`${base}/api/v1/lark/callback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('not configured');
  });
});

describe('dingtalk routes', () => {
  it('GET /health → { data: { status, service } }（统一壳）', async () => {
    const res = await fetch(`${base}/api/v1/dingtalk/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'ok', service: 'dingtalk-callback' } });
  });

  it('GET /action 无 action 参数 → HTML 提示（协议面不变）', async () => {
    const res = await fetch(`${base}/api/v1/dingtalk/action`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('无效操作');
  });
});
