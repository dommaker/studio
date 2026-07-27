// Deploy Webhook 路由测试 — HMAC-SHA256 校验 / 事件与分支过滤 / 异步触发部署脚本
// 风格同 knowledge-service.routes.test.ts：挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SECRET = 'test-deploy-secret';
let tmpDir: string;
let marker: string;
let server: Server;
let base: string;
let prevSecret: string | undefined;
let prevScript: string | undefined;

function sign(payload: string, secret: string = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function post(payload: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1/deploy/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-webhook-'));
  marker = path.join(tmpDir, 'triggered');
  const deployScript = path.join(tmpDir, 'deploy.sh');
  fs.writeFileSync(deployScript, `#!/bin/bash\necho fired >> "${marker}"\n`, { mode: 0o755 });

  prevSecret = process.env.DEPLOY_WEBHOOK_SECRET;
  prevScript = process.env.DEPLOY_SCRIPT;
  process.env.DEPLOY_WEBHOOK_SECRET = SECRET;
  process.env.DEPLOY_SCRIPT = deployScript;

  const { deployWebhookRoutes } = await import('../webhook.routes.js');
  const app = express();
  // 与 app.ts 一致：该路径挂 express.raw 保留原始 body 供 HMAC 校验
  app.use('/api/v1/deploy/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/v1/deploy', deployWebhookRoutes);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.DEPLOY_WEBHOOK_SECRET;
  else process.env.DEPLOY_WEBHOOK_SECRET = prevSecret;
  if (prevScript === undefined) delete process.env.DEPLOY_SCRIPT;
  else process.env.DEPLOY_SCRIPT = prevScript;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deploy webhook', () => {
  it('签名正确 + push master → 202 accepted 并异步触发部署脚本', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master' });
    const { status, json } = await post(payload, {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
    });
    expect(status).toBe(202);
    expect(json.accepted).toBe(true);

    // 异步触发：轮询 marker 文件出现
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('签名错误 → 401', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master' });
    const { status } = await post(payload, {
      'x-hub-signature-256': sign(payload, 'wrong-secret'),
      'x-github-event': 'push',
    });
    expect(status).toBe(401);
  });

  it('缺签名 → 401', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master' });
    const { status } = await post(payload, { 'x-github-event': 'push' });
    expect(status).toBe(401);
  });

  it('非 push 事件 → 202 ignored，不触发', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master' });
    const { status, json } = await post(payload, {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'ping',
    });
    expect(status).toBe(202);
    expect(json.ignored).toBeTruthy();
  });

  it('push 非 master 分支 → 202 ignored，不触发', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/feat/x' });
    const { status, json } = await post(payload, {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
    });
    expect(status).toBe(202);
    expect(json.ignored).toBe('refs/heads/feat/x');
  });

  it('未配置 DEPLOY_SCRIPT → 503，不触发', async () => {
    const saved = process.env.DEPLOY_SCRIPT;
    delete process.env.DEPLOY_SCRIPT;
    try {
      const payload = JSON.stringify({ ref: 'refs/heads/master' });
      const { status, json } = await post(payload, {
        'x-hub-signature-256': sign(payload),
        'x-github-event': 'push',
      });
      expect(status).toBe(503);
      expect(json.error).toContain('DEPLOY_SCRIPT');
    } finally {
      if (saved === undefined) delete process.env.DEPLOY_SCRIPT;
      else process.env.DEPLOY_SCRIPT = saved;
    }
  });
});
