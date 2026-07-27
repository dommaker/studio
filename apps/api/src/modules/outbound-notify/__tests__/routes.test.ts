// outbound-notify 路由测试 — /config + /config/status 用户渠道配置（进程内存）
// 风格同 deploy/webhook.routes.test.ts：挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import notifyRoutes from '../routes.js';

let server: Server;
let base: string;

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1/notify${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notify', notifyRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('notify config routes', () => {
  it('GET /config/status 初始各渠道 hasUserConfig=false', async () => {
    const { status, json } = await req('GET', '/config/status');
    expect(status).toBe(200);
    expect(json).toEqual({
      discord: { hasUserConfig: false },
      wecom: { hasUserConfig: false },
      telegram: { hasUserConfig: false },
    });
  });

  it('POST /config 保存后 status 反映 webhookUrl / botToken+chatId', async () => {
    const saved = await req('POST', '/config', {
      discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/xxx' },
      wecom: { enabled: false, webhookUrl: '' },
      telegram: { enabled: true, botToken: '123:abc', chatId: '-1001' },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.success).toBe(true);

    const { status, json } = await req('GET', '/config/status');
    expect(status).toBe(200);
    expect(json.discord.hasUserConfig).toBe(true);
    expect(json.wecom.hasUserConfig).toBe(false);
    expect(json.telegram.hasUserConfig).toBe(true);
  });

  it('POST /config 空 body 不报错，status 全 false', async () => {
    const saved = await req('POST', '/config', {});
    expect(saved.status).toBe(200);

    const { json } = await req('GET', '/config/status');
    expect(json.discord.hasUserConfig).toBe(false);
    expect(json.wecom.hasUserConfig).toBe(false);
    expect(json.telegram.hasUserConfig).toBe(false);
  });
});
