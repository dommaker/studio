import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Router } from 'express';

let knowledgeServiceRoutes: Router;

describe('KnowledgeService routes', () => {
  it('exports a valid Express router', () => {
    expect(knowledgeServiceRoutes).toBeDefined();
    expect(typeof knowledgeServiceRoutes.use).toBe('function');
    expect(typeof knowledgeServiceRoutes.get).toBe('function');
    expect(typeof knowledgeServiceRoutes.post).toBe('function');
  });
});

// ── 审核闭环：/promote、/demote 生命周期端点 + /entries maturity 过滤（集成） ──
// 风格同 entries.routes.test.ts：HOME 指向临时目录隔离 sharedStore（~/.studio/knowledge），
// 挂载真实 router + 真实 FileKnowledgeStore，走 HTTP 验证端到端行为。

let tmpHome: string;
let prevHome: string | undefined;
let server: Server;
let base: string;
let sharedIngest: any;
let sharedStore: any;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function seed(title: string, maturity: string): { id: string } {
  const saved = sharedIngest.ingestEntry(
    { type: 'guideline', title, content: `${title} — 足够长的内容以通过形态与质量门禁检查。`, tags: ['test'] },
    { source: 'test:routes', layer: 'project', maturity, tags: ['test'], consumptionMode: 'signal' },
  );
  return { id: saved.id };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-service-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const singletons = await import('../knowledge-singletons.js');
  sharedIngest = singletons.sharedIngest;
  sharedStore = singletons.sharedStore;

  const routes = (await import('../knowledge-service.routes.js')).knowledgeServiceRoutes;
  knowledgeServiceRoutes = routes;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge-service', routes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge-service`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('KnowledgeService routes — 审核闭环生命周期端点', () => {
  it('POST /promote：draft → verified', async () => {
    const { id } = seed('路由测试 promote 条目', 'draft');
    const res = await api('POST', '/promote', { entryId: id });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(sharedStore.get(id).maturity).toBe('verified');
  });

  it('POST /demote：draft → archived（reject 语义，与 /promote 对称）', async () => {
    const { id } = seed('路由测试 demote 条目', 'draft');
    const res = await api('POST', '/demote', { entryId: id });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(sharedStore.get(id).maturity).toBe('archived');
  });

  it('POST /demote：缺 entryId → 400', async () => {
    const res = await api('POST', '/demote', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('entryId');
  });

  it('POST /demote：verified 条目不受影响（仅 draft 可 demote）', async () => {
    const { id } = seed('路由测试 demote 非 draft 条目', 'verified');
    const res = await api('POST', '/demote', { entryId: id });
    expect(res.status).toBe(200);
    expect(sharedStore.get(id).maturity).toBe('verified');
  });
});

describe('KnowledgeService routes — GET /entries maturity 过滤', () => {
  it('?maturity=draft 只返回 draft 条目（监控页待审列表数据源）', async () => {
    // 标题刻意拉开距离，避免 harness ingest 语义去重（标题重叠 ≥0.6 合并）把两条并掉
    seed('Alpha 待审提案条目', 'draft');
    seed('Zeta 已审核通过条目', 'verified');
    const res = await api('GET', '/entries?maturity=draft&limit=50');
    expect(res.status).toBe(200);
    const entries = res.json.entries as any[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.maturity === 'draft')).toBe(true);
    expect(entries.some(e => e.title === 'Alpha 待审提案条目')).toBe(true);
    expect(entries.some(e => e.title === 'Zeta 已审核通过条目')).toBe(false);
  });
});
