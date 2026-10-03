// GET /knowledge-service/entries/stats 防遮蔽 + healthScore 修复回归测试：
// 历史上 ①注册在 /entries/:id 之后被 id='stats' 吞掉；②读 HealthReport 不存在的
// healthScore 字段（恒 undefined 被 JSON 丢弃）。修复后：可达且 healthScore = score 数值。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-stats-route-'));
process.env.STUDIO_HOME = testHome;
afterAll(() => { fs.rmSync(testHome, { recursive: true, force: true }); });

const { knowledgeServiceRoutes } = await import('../knowledge-service.routes.js');

describe('GET /knowledge-service/entries/stats（防遮蔽 + healthScore 回归）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/knowledge-service', knowledgeServiceRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('/entries/stats 可达且 healthScore 是数值（不再恒 undefined）', async () => {
    const res = await fetch(`${base}/api/v1/knowledge-service/entries/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.healthScore).toBe('number');
  });

  it('/entries/:id 对不存在条目仍 404（参数路由不受影响）', async () => {
    const res = await fetch(`${base}/api/v1/knowledge-service/entries/no-such-entry`);
    expect(res.status).toBe(404);
  });
});
