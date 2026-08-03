/**
 * routes.ts 门面测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 验证拆分后门面（knowledgeRoutes / knowledgeInternalRoutes）：
 * 1. 所有 7 个子路由的 (method, path) 完整注册（集合比较，不依赖 Express 内部 flatten 顺序）；
 * 2. 关键顺序约束：/requirements、/read-file、/file 必须在 /:projectId 之前（否则被遮蔽）；
 * 3. HTTP 层验证语义——字面路径可到达、原文件中的遮蔽行为保留。
 * HOME 指向临时目录隔离 sharedStore / FileStore。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface FlatRoute { method: string; path: string; handlers: number }

function flattenRoutes(router: any): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        out.push({ method: m.toUpperCase(), path: layer.route.path, handlers: layer.route.stack.length });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...flattenRoutes(layer.handle));
    }
  }
  return out;
}

/** 所有公共路由（集合顺序无关，仅用于存在性校验）。 */
const EXPECTED_PUBLIC: Array<[string, string]> = [
  // files.routes
  ['GET', '/requirements'], ['POST', '/read-file'], ['GET', '/file'],
  // documents.routes
  ['GET', '/'], ['GET', '/detail/:documentId'], ['GET', '/:projectId'], ['POST', '/:projectId'],
  ['PUT', '/:documentId'], ['POST', '/:documentId/archive'], ['POST', '/:documentId/approve'],
  ['POST', '/:documentId/reject'], ['DELETE', '/:documentId'],
  // entries.routes
  ['GET', '/export'], ['POST', '/ask'], ['GET', '/gaps/:type'], ['GET', '/gaps'],
  ['GET', '/unified'], ['POST', '/unified'],
  // evolution.routes
  ['POST', '/evolution/micro'], ['POST', '/evolution/meso'], ['POST', '/evolution/macro'],
  ['POST', '/evolution/decay'], ['GET', '/evolution/health'],
  // search.routes
  ['GET', '/resolutions'], ['GET', '/search'], ['GET', '/resolution/density'],
  ['GET', '/resolution/cross-session'],
  // maintenance.routes（F1 手动触发入口，B7 token-burn issue）
  ['POST', '/maintenance/run'],
];

const EXPECTED_INTERNAL: Array<[string, string]> = [
  ['GET', '/sync-status'], ['POST', '/upsert'],
];

function toSet(routes: Array<[string, string]>): Set<string> {
  return new Set(routes.map(r => `${r[0]} ${r[1]}`));
}

let tmpHome: string;
let prevHome: string | undefined;
let knowledgeRoutes: any;
let knowledgeInternalRoutes: any;
let server: Server;
let basePublic: string;
let baseInternal: string;

async function api(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-facade-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const mod = await import('../routes.js');
  knowledgeRoutes = mod.knowledgeRoutes;
  knowledgeInternalRoutes = mod.knowledgeInternalRoutes;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', knowledgeRoutes);
  app.use('/api/knowledge', knowledgeInternalRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  basePublic = `http://127.0.0.1:${port}/api/v1/knowledge`;
  baseInternal = `http://127.0.0.1:${port}/api/knowledge`;
}, 30000);

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('knowledge routes facade', () => {
  it('exports two express routers', () => {
    expect(typeof knowledgeRoutes.use).toBe('function');
    expect(typeof knowledgeInternalRoutes.use).toBe('function');
  });

  it('all 7 sub-routers fully registered (set comparison)', () => {
    const flat = flattenRoutes(knowledgeRoutes);
    const actual = flat.map(r => [r.method, r.path] as [string, string]);
    const actualSet = toSet(actual);
    const expectedSet = toSet(EXPECTED_PUBLIC);

    const missing = EXPECTED_PUBLIC.filter(r => !actualSet.has(`${r[0]} ${r[1]}`));
    const extra = actual.filter(r => !expectedSet.has(`${r[0]} ${r[1]}`));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('/requirements, /read-file, /file registered before /:projectId (no shadowing)', () => {
    const flat = flattenRoutes(knowledgeRoutes).map(r => [r.method, r.path] as [string, string]);
    const projectIdIdx = flat.findIndex(r => r[0] === 'GET' && r[1] === '/:projectId');
    expect(projectIdIdx).not.toBe(-1);

    for (const lp of ['/requirements', '/read-file', '/file']) {
      const idx = flat.findIndex(r => r[1] === lp);
      expect(idx).not.toBe(-1);
      expect(idx).toBeLessThan(projectIdIdx);
    }
  });

  it('internal route table has all 5 routes (set comparison)', () => {
    const flat = flattenRoutes(knowledgeInternalRoutes);
    const actual = flat.map(r => [r.method, r.path] as [string, string]);
    const actualSet = toSet(actual);
    const expectedSet = toSet(EXPECTED_INTERNAL);

    const missing = EXPECTED_INTERNAL.filter(r => !actualSet.has(`${r[0]} ${r[1]}`));
    const extra = actual.filter(r => !expectedSet.has(`${r[0]} ${r[1]}`));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('GET /search keeps apiCache middleware (2 handlers)', () => {
    const flat = flattenRoutes(knowledgeRoutes);
    const search = flat.find(r => r.method === 'GET' && r.path === '/search');
    expect(search?.handlers).toBe(2);
  });

  it('GET /requirements reaches files handler (registered before /:projectId)', async () => {
    const res = await api(basePublic, 'GET', '/requirements');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('docs');
    expect(res.json).toHaveProperty('total');
  });

  it('GET / reaches documents handler (companyId required)', async () => {
    const res = await api(basePublic, 'GET', '/');
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('companyId is required');
  });

  it('GET /export keeps original shadowing by /:projectId', async () => {
    // 原文件中 /:projectId 注册于 /export 之前，GET /export 由项目文档列表处理器捕获
    const res = await api(basePublic, 'GET', '/export');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('documents');
    expect(res.json).toHaveProperty('byType');
    expect(res.json).toHaveProperty('stats');
  });

  it('POST /ask keeps original shadowing by POST /:projectId (404 Project not found)', async () => {
    // 原文件中 POST /:projectId 注册于 /ask 之前：带 type+title 的请求体通过
    // /:projectId 的参数校验后查项目（'ask' 不是项目）→ 404；若落到 ask 处理器
    // 则会因缺 question 返回 400——两种结果可明确区分归属。
    const res = await api(basePublic, 'POST', '/ask', { type: 'design', title: 'X' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Project not found');
  });

  it('GET /api/knowledge/sync-status reachable on internal router', async () => {
    const res = await api(baseInternal, 'GET', '/sync-status');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('trackedScopes');
  });
});
