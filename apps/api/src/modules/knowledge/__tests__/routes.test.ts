/**
 * routes.ts 门面测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 验证拆分后门面（knowledgeRoutes / knowledgeInternalRoutes）：
 * 1. 所有子路由的 (method, path) 完整注册（集合比较，不依赖 Express 内部 flatten 顺序）；
 * 2. HTTP 层验证语义——字面路径可到达。
 * HOME 指向临时目录隔离 sharedStore / FileStore。
 *
 * #149（2026-08-15）：document-store 退役，documents.routes / evolution.routes 摘除；
 * 原 /:projectId 通配路由消失，/export /ask 等字面路径不再被遮蔽（原遮蔽行为测试一并移除）。
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
  // entries.routes
  ['GET', '/export'], ['POST', '/ask'], ['GET', '/gaps/:type'], ['GET', '/gaps'],
  ['GET', '/unified'], ['POST', '/unified'],
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

  it('all 4 sub-routers fully registered (set comparison)', () => {
    const flat = flattenRoutes(knowledgeRoutes);
    const actual = flat.map(r => [r.method, r.path] as [string, string]);
    const actualSet = toSet(actual);
    const expectedSet = toSet(EXPECTED_PUBLIC);

    const missing = EXPECTED_PUBLIC.filter(r => !actualSet.has(`${r[0]} ${r[1]}`));
    const extra = actual.filter(r => !expectedSet.has(`${r[0]} ${r[1]}`));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('internal route table has all 2 routes (set comparison)', () => {
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

  it('GET /requirements reaches files handler', async () => {
    const res = await api(basePublic, 'GET', '/requirements');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('docs');
    expect(res.json).toHaveProperty('total');
  });

  it('GET /api/knowledge/sync-status reachable on internal router', async () => {
    const res = await api(baseInternal, 'GET', '/sync-status');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('trackedScopes');
  });
});
