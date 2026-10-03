// GET /api/v1/skills/stats 防遮蔽回归测试：
// 历史上注册在 GET /:id 之后被 id='stats' 吞掉（恒 404 Skill not found），
// 修复后必须先注册。风格对齐 skill-manifest-route.test.ts：真 express app + fetch。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-stats-route-'));
process.env.STUDIO_HOME = testHome;
process.env.SKILLS_DIR = path.join(testHome, 'skills');
afterAll(() => { fs.rmSync(testHome, { recursive: true, force: true }); });

const { skillsOpenRoutes } = await import('../routes.js');

describe('GET /skills/stats（防 /:id 遮蔽回归）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/skills', skillsOpenRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('/stats 到达统计处理器（不被 /:id 吞掉）', async () => {
    const res = await fetch(`${base}/api/v1/skills/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 统计处理器返回聚合字段；被 /:id 吞掉则是 404 Skill not found
    expect(body.data).toHaveProperty('totalSkills');
    expect(body.data).toHaveProperty('byCategory');
    expect(body.data).toHaveProperty('topSkills');
  });

  it('/:id 对不存在 skill 仍 404（参数路由不受影响）', async () => {
    const res = await fetch(`${base}/api/v1/skills/no-such-skill`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});
