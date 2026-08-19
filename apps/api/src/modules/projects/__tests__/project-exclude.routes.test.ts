// #266（决策 #258）：归属候选排除清单 CRUD 路由测试 — GET/PUT /api/v1/projects/exclude
// 风格同 outbound-notify/__tests__/routes.test.ts：STUDIO_HOME 指向 tmp 隔离真实数据，
// 挂载真实 router 起 HTTP 服务，fetch 验证；STUDIO_PROJECTS_ROOT 指向 tmp 工程根供 /discover 扫描。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Router } from 'express';

let tmpHome: string;
let tmpProjectsRoot: string;
let server: Server;
let base: string;
let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ['HOME', 'STUDIO_HOME', 'STUDIO_PROJECTS_ROOT', 'STUDIO_PROJECTS_EXCLUDE'] as const;

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1/projects${p}`, {
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
  app.use('/api/v1/projects', routes);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-routes-'));
  tmpProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-root-'));
  // 两个待发现工程（CLAUDE.md 标记）
  for (const name of ['alpha-proj', 'beta-proj']) {
    fs.mkdirSync(path.join(tmpProjectsRoot, name));
    fs.writeFileSync(path.join(tmpProjectsRoot, name, 'CLAUDE.md'), `# ${name}`);
  }

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = tmpHome;
  process.env.STUDIO_HOME = path.join(tmpHome, '.studio');
  process.env.STUDIO_PROJECTS_ROOT = tmpProjectsRoot;
  delete process.env.STUDIO_PROJECTS_EXCLUDE;

  const { default: projectRoutes } = await import('../project.routes.js');
  await listenOn(projectRoutes);
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProjectsRoot, { recursive: true, force: true });
});

describe('#266: projects exclude 排除清单 CRUD 路由', () => {
  it('GET /exclude 初始为空清单', async () => {
    const { status, json } = await req('GET', '/exclude');
    expect(status).toBe(200);
    expect(json).toEqual({ success: true, data: { exclude: [] } });
  });

  it('PUT /exclude 保存后 GET 反映，且落盘到 projects-exclude.json', async () => {
    const saved = await req('PUT', '/exclude', { exclude: ['beta-proj', '/data/secret'] });
    expect(saved.status).toBe(200);
    expect(saved.json.success).toBe(true);

    const { status, json } = await req('GET', '/exclude');
    expect(status).toBe(200);
    expect(json.data.exclude).toEqual(['beta-proj', '/data/secret']);

    const file = path.join(tmpHome, '.studio', 'projects-exclude.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).exclude).toEqual(['beta-proj', '/data/secret']);
  });

  it('PUT /exclude 后 /discover 候选即时生效（缓存主动失效，被排除工程不再出现）', async () => {
    // 前置清空（上个用例保存过排除清单，文件态跨用例延续）
    await req('PUT', '/exclude', { exclude: [] });
    const before = await req('GET', '/discover');
    expect(before.json.data.map((p: any) => p.name)).toContain('beta-proj');

    const saved = await req('PUT', '/exclude', { exclude: ['beta-proj'] });
    expect(saved.status).toBe(200);

    const after = await req('GET', '/discover');
    const names = after.json.data.map((p: any) => p.name);
    expect(names).toContain('alpha-proj');
    expect(names).not.toContain('beta-proj');
  });

  it('PUT /exclude 非法 body（非字符串数组）→ 400，不落盘', async () => {
    const file = path.join(tmpHome, '.studio', 'projects-exclude.json');
    const beforeOnDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;

    for (const bad of [{ exclude: 'beta-proj' }, { exclude: [1, 2] }, {}]) {
      const { status } = await req('PUT', '/exclude', bad);
      expect(status).toBe(400);
    }

    const afterOnDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    expect(afterOnDisk).toBe(beforeOnDisk);
  });

  it('GET /exclude 配置文件损坏 → 降级空清单不炸', async () => {
    const file = path.join(tmpHome, '.studio', 'projects-exclude.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ broken');

    const { status, json } = await req('GET', '/exclude');
    expect(status).toBe(200);
    expect(json.data.exclude).toEqual([]);
  });
});
