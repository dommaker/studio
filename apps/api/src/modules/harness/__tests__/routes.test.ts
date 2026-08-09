/**
 * routes.ts 门面测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 验证拆分后门面（default export router）：
 * 1. 全部 10 个子路由的 44 个 (method, path) 完整注册（集合比较）；
 * 2. 关键顺序约束：GET /constraints/stats 必须在 GET /constraints/:id 之前；
 * 3. HTTP 层冒烟：/health、/verify/rules、/agents、/api/v1/cso/validate 可达
 *    （部分 mock @dommaker/harness：保留真实模块，仅覆盖 AgentLifecycle/CSOValidator）。
 * HOME 指向临时目录隔离 knowledge-bus 链路。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 部分 mock：保留真实模块（studio-shared 初始化需要 CheckpointValidator 等真实导出），
// 仅覆盖 HTTP 冒烟涉及的 AgentLifecycle / CSOValidator。
vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return {
    ...actual,
    AgentLifecycle: class {
      getAllStates() {
        return [];
      }
    },
    CSOValidator: undefined,
  };
});

interface FlatRoute { method: string; path: string }

function flattenRoutes(router: any): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        out.push({ method: m.toUpperCase(), path: layer.route.path });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...flattenRoutes(layer.handle));
    }
  }
  return out;
}

/** 原单文件的全部路由（集合顺序无关，仅用于存在性校验）。
 *  harness 0.17.0（ADR-0001 决策 8）：删 /evolve、/constraints/:id/degrade、
 *  /constraints/:id/schedule，增 GET /constraints/retired → 42 个。 */
const EXPECTED: Array<[string, string]> = [
  // traces.routes
  ['GET', '/traces'], ['POST', '/traces'], ['GET', '/analysis'],
  ['GET', '/analysis/anomalies'], ['POST', '/diagnose'],
  // proposals.routes
  ['GET', '/proposals'], ['POST', '/proposals/:id/review'],
  ['POST', '/proposals/:id/execute'],
  // constraints.routes
  ['GET', '/constraints'], ['GET', '/constraints/stats'], ['GET', '/constraints/retired'],
  ['GET', '/constraints/:id'], ['POST', '/constraints/:id/rollback'],
  ['POST', '/check-constraints'],
  // guards.routes
  ['POST', '/check-input'], ['POST', '/check-output'], ['GET', '/sandbox'],
  // knowledge.routes
  ['POST', '/knowledge/query'], ['GET', '/knowledge'], ['GET', '/knowledge/:id'],
  ['POST', '/knowledge'], ['DELETE', '/knowledge/:id'], ['POST', '/knowledge/lint'],
  // sessions.routes
  ['POST', '/estimate-tokens'], ['POST', '/sessions'], ['POST', '/sessions/:id/events'],
  ['GET', '/sessions/:id'], ['POST', '/sessions/:id/checkpoint'],
  // agents.routes
  ['POST', '/agents'], ['POST', '/agents/:id/start'], ['POST', '/agents/:id/complete'],
  ['POST', '/agents/:id/fail'], ['GET', '/agents'], ['GET', '/agents/:id'],
  // diagnostics.routes
  ['POST', '/classify'], ['POST', '/failures'], ['POST', '/check-spec'],
  ['POST', '/verify'], ['GET', '/verify/rules'],
  // dashboard.routes
  ['GET', '/dashboard'], ['GET', '/health'],
  // cso.routes
  ['GET', '/validate'],
];

let tmpHome: string;
let prevHome: string | undefined;
let harnessRoutes: any;
let server: Server;
let baseHarness: string;
let baseCso: string;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-facade-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const mod = await import('../routes.js');
  harnessRoutes = mod.default;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', harnessRoutes);
  app.use('/api/v1/cso', harnessRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  baseHarness = `http://127.0.0.1:${port}/api/v1/harness`;
  baseCso = `http://127.0.0.1:${port}/api/v1/cso`;
}, 30000);

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('harness routes facade', () => {
  it('default-exports an express router', () => {
    expect(typeof harnessRoutes.use).toBe('function');
    expect(typeof harnessRoutes.handle).toBe('function');
  });

  it('all 10 sub-routers fully registered: 42 routes (set comparison)', () => {
    const flat = flattenRoutes(harnessRoutes);
    const actualSet = new Set(flat.map(r => `${r.method} ${r.path}`));
    const expectedSet = new Set(EXPECTED.map(r => `${r[0]} ${r[1]}`));

    const missing = EXPECTED.filter(r => !actualSet.has(`${r[0]} ${r[1]}`));
    const extra = flat.filter(r => !expectedSet.has(`${r.method} ${r.path}`));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(flat).toHaveLength(42);
  });

  it('GET /constraints/stats registered before GET /constraints/:id (no shadowing)', () => {
    const flat = flattenRoutes(harnessRoutes);
    const statsIdx = flat.findIndex(r => r.method === 'GET' && r.path === '/constraints/stats');
    const idIdx = flat.findIndex(r => r.method === 'GET' && r.path === '/constraints/:id');
    expect(statsIdx).not.toBe(-1);
    expect(idIdx).not.toBe(-1);
    expect(statsIdx).toBeLessThan(idIdx);
  });

  it('GET /api/v1/harness/health reachable (200 ok)', async () => {
    const res = await fetch(`${baseHarness}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', harness: 'connected', constraintsActive: true });
  });

  it('GET /api/v1/harness/verify/rules reachable (200, 4 rules)', async () => {
    const res = await fetch(`${baseHarness}/verify/rules`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(4);
  });

  it('GET /api/v1/harness/agents reaches agents handler (200 empty list, not 404)', async () => {
    // 证明 /agents 已由 agents 子路由接管：mock 的 AgentLifecycle 返回空列表 → 200；
    // 若未挂载则为 Express 默认 404。
    const res = await fetch(`${baseHarness}/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], total: 0 });
  });

  it('GET /api/v1/cso/validate reachable on cso mount (validator unavailable note)', async () => {
    const res = await fetch(`${baseCso}/validate`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true, issues: [], note: 'CSOValidator not available' });
  });

  it('unregistered path falls through to Express 404', async () => {
    const res = await fetch(`${baseHarness}/no-such-endpoint`);
    expect(res.status).toBe(404);
  });
});
