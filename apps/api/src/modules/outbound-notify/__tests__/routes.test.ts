// outbound-notify 路由测试 — /config + /config/status 用户渠道配置（持久化到 ~/.studio/notify-config.json）
// 风格同 companies/routes.test.ts：HOME 指向 tmp 隔离真实数据，挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Router } from 'express';

let tmpHome: string;
let server: Server;
let base: string;
let prevHome: string | undefined;

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1/notify${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function listenOn(routes: Router): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notify', routes);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  // 模块加载时即计算 CONFIG_FILE（os.homedir()），须先于 import 设置 HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { default: notifyRoutes } = await import('../routes.js');
  await listenOn(notifyRoutes);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpHome, { recursive: true, force: true });
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

  it('POST /config 保存后 status 反映 webhookUrl / botToken+chatId，且落盘到 notify-config.json', async () => {
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

    const file = path.join(tmpHome, '.studio', 'notify-config.json');
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.discord.webhookUrl).toBe('https://discord.com/api/webhooks/xxx');
  });

  it('C5: 模拟服务重启（重新加载模块）后配置从磁盘恢复，无需重新保存', async () => {
    await new Promise(resolve => server.close(resolve));

    vi.resetModules();
    const { default: freshRoutes } = await import('../routes.js');
    await listenOn(freshRoutes);

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
