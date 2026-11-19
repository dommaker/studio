// Deploy Webhook 路由测试 — HMAC-SHA256 校验 / 事件与分支过滤 / 异步触发部署脚本
// 风格同 knowledge-service.routes.test.ts：挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
let deployLog: string;
let server: Server;
let base: string;
let prevSecret: string | undefined;
let prevScript: string | undefined;
let prevLog: string | undefined;

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
  deployLog = path.join(tmpDir, 'deploy.log');
  const deployScript = path.join(tmpDir, 'deploy.sh');
  fs.writeFileSync(deployScript, `#!/bin/bash\necho fired >> "${marker}"\necho "deploy-output-line"\n`, { mode: 0o755 });

  prevSecret = process.env.DEPLOY_WEBHOOK_SECRET;
  prevScript = process.env.DEPLOY_SCRIPT;
  prevLog = process.env.DEPLOY_LOG;
  process.env.DEPLOY_WEBHOOK_SECRET = SECRET;
  process.env.DEPLOY_SCRIPT = deployScript;
  process.env.DEPLOY_LOG = deployLog;

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
  if (prevLog === undefined) delete process.env.DEPLOY_LOG;
  else process.env.DEPLOY_LOG = prevLog;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deploy webhook', () => {
  it('签名正确 + push master → 202 accepted 并异步触发部署脚本', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master', after: 'a'.repeat(40) });
    const { status, json } = await post(payload, {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-initial',
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

  it('部署脚本 stdout/stderr 落 DEPLOY_LOG（stdio 不得为 ignore）', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master', after: 'b'.repeat(40) });
    const { status } = await post(payload, {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-logging',
    });
    expect(status).toBe(202);

    // 轮询日志文件接住脚本输出（2026-08-09 回归：stdio ignore 导致部署零日志）
    const deadline = Date.now() + 5000;
    let content = '';
    while (Date.now() < deadline) {
      content = fs.existsSync(deployLog) ? fs.readFileSync(deployLog, 'utf-8') : '';
      if (content.includes('deploy-output-line')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(content).toContain('deploy-output-line');
  });

  it('同 delivery 重放不再次部署，也不改部署日志或重放台账', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master', after: 'c'.repeat(40) });
    const headers = {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-replayed',
    };
    expect((await post(payload, headers)).status).toBe(202);
    const deadline = Date.now() + 5000;
    while ((!fs.existsSync(marker) || !fs.existsSync(deployLog)) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 100));
    const markerBefore = fs.readFileSync(marker, 'utf8');
    const logBefore = fs.readFileSync(deployLog, 'utf8');
    const { getStore } = await import('../../../core/store.js');
    const ledgerPath = path.join(getStore().getDataDir(), 'webhook-replays.json');
    const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');

    const replay = await post(payload, headers);
    await new Promise(r => setTimeout(r, 200));

    expect(replay.status).toBe(202);
    expect(replay.json.ignored).toBe('duplicate request');
    expect(fs.readFileSync(marker, 'utf8')).toBe(markerBefore);
    expect(fs.readFileSync(deployLog, 'utf8')).toBe(logBefore);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
  });

  it('不同 delivery 携带同 commit 也不重复部署', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master', after: 'd'.repeat(40) });
    const firstHeaders = {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-commit-first',
    };
    expect((await post(payload, firstHeaders)).status).toBe(202);
    await new Promise(r => setTimeout(r, 200));
    const markerBefore = fs.readFileSync(marker, 'utf8');

    const replay = await post(payload, { ...firstHeaders, 'x-github-delivery': 'delivery-commit-second' });
    await new Promise(r => setTimeout(r, 200));

    expect(replay.status).toBe(202);
    expect(replay.json.ignored).toBe('duplicate request');
    expect(fs.readFileSync(marker, 'utf8')).toBe(markerBefore);
  });

  it('超过 24h 后不同 delivery 同 commit 仍零 spawn、零日志、零台账写', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const payload = JSON.stringify({ ref: 'refs/heads/master', after: 'f'.repeat(40) });
      const headers = {
        'x-hub-signature-256': sign(payload),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-permanent-first',
      };
      expect((await post(payload, headers)).status).toBe(202);
      await new Promise(r => setTimeout(r, 200));
      const markerBefore = fs.readFileSync(marker, 'utf8');
      const logBefore = fs.readFileSync(deployLog, 'utf8');
      const { getStore } = await import('../../../core/store.js');
      const ledgerPath = path.join(getStore().getDataDir(), 'webhook-replays.json');
      const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');

      now += 24 * 60 * 60 * 1000 + 1;
      const replay = await post(payload, { ...headers, 'x-github-delivery': 'delivery-permanent-second' });
      await new Promise(r => setTimeout(r, 200));

      expect(replay.status).toBe(202);
      expect(replay.json.ignored).toBe('duplicate request');
      expect(fs.readFileSync(marker, 'utf8')).toBe(markerBefore);
      expect(fs.readFileSync(deployLog, 'utf8')).toBe(logBefore);
      expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
    } finally {
      Date.now = realNow;
    }
  });

  it('spawn 后 complete 失败返回 503 且保留占位，重试零副作用', async () => {
    const { ReplayGuard } = await import('../../../core/replay-guard.js');
    const complete = vi.spyOn(ReplayGuard.prototype, 'complete').mockRejectedValueOnce(new Error('complete failed'));
    try {
      const payload = JSON.stringify({ ref: 'refs/heads/master', after: '1'.repeat(40) });
      const headers = {
        'x-hub-signature-256': sign(payload),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-complete-failed',
      };
      const first = await post(payload, headers);
      await new Promise(r => setTimeout(r, 200));
      const markerBefore = fs.readFileSync(marker, 'utf8');
      const logBefore = fs.readFileSync(deployLog, 'utf8');

      const replay = await post(payload, headers);
      await new Promise(r => setTimeout(r, 200));

      expect(first.status).toBe(503);
      expect(replay.status).toBe(202);
      expect(replay.json.ignored).toBe('duplicate request');
      expect(fs.readFileSync(marker, 'utf8')).toBe(markerBefore);
      expect(fs.readFileSync(deployLog, 'utf8')).toBe(logBefore);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      complete.mockRestore();
    }
  });

  it('并发同 delivery 仅一个请求产生部署副作用', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/master', after: 'e'.repeat(40) });
    const headers = {
      'x-hub-signature-256': sign(payload),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-concurrent',
    };
    const markerBefore = fs.readFileSync(marker, 'utf8');

    const responses = await Promise.all([post(payload, headers), post(payload, headers)]);
    await new Promise(r => setTimeout(r, 300));

    expect(responses.filter(response => response.json.accepted === true)).toHaveLength(1);
    expect(responses.filter(response => response.json.ignored === 'duplicate request')).toHaveLength(1);
    const markerAfter = fs.readFileSync(marker, 'utf8');
    expect(markerAfter.slice(markerBefore.length).trim().split('\n').filter(Boolean)).toHaveLength(1);
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
