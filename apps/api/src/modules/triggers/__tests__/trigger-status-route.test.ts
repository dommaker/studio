// GET /api/v1/triggers/status 防遮蔽回归测试：
// 历史上注册在 GET /:id 之后被 id='status' 吞掉（恒 404 Trigger not found），修复后必须先注册。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-status-route-'));
process.env.STUDIO_HOME = testHome;
afterAll(() => { fs.rmSync(testHome, { recursive: true, force: true }); });

const { triggerRouter } = await import('../trigger.routes.js');

describe('GET /triggers/status（防 /:id 遮蔽回归）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/triggers', triggerRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('/status 到达调度器状态处理器（不被 /:id 吞掉）', async () => {
    const res = await fetch(`${base}/api/v1/triggers/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty('running');
    expect(body.data).toHaveProperty('triggerCount');
    expect(body.data).toHaveProperty('logCount');
  });

  it('/:id 对不存在 trigger 仍 404（参数路由不受影响）', async () => {
    const res = await fetch(`${base}/api/v1/triggers/no-such-trigger`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});
