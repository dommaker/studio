/**
 * constraints.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（内存态 ConstraintRegistry + checkConstraints），
 * 挂载 constraintsRoutes 覆盖：GET /constraints、GET /constraints/stats、
 * GET /constraints/:id、POST degrade/rollback/schedule（含 safety 层 400）、
 * POST /check-constraints。HOME 指向临时目录隔离 knowledge-bus 链路。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  const store = new Map<string, any>([
    ['c-safe', { id: 'c-safe', level: 'L1', layer: 'safety', deprecationStatus: 'active' }],
    ['c-quality', { id: 'c-quality', level: 'L2', layer: 'quality', deprecationStatus: 'active' }],
  ]);
  return {
    ...actual,
    ConstraintRegistry: class {
      getAll() {
        return [...store.values()];
      }
      getLayerStats() {
        return { safety: 1, quality: 1 };
      }
      get(id: string) {
        return store.get(id);
      }
      degrade() {
        return true;
      }
      rollback() {
        return true;
      }
      scheduleDeprecation() {
        return true;
      }
    },
    checkConstraints: async (opts: { operation: string }) => ({
      passed: true,
      operation: opts.operation,
      violations: [],
    }),
  };
});

let tmpHome: string;
let prevHome: string | undefined;
let server: Server;
let base: string;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-constraints-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { constraintsRoutes } = await import('../constraints.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', constraintsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('constraints.routes', () => {
  it('GET /constraints lists mapped constraints', async () => {
    const res = await api('GET', '/constraints');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(res.json.data.map((c: any) => c.id).sort()).toEqual(['c-quality', 'c-safe']);
    expect(res.json.data[0]).toHaveProperty('layer');
  });

  it('GET /constraints/stats returns layer stats (not shadowed by /:id)', async () => {
    const res = await api('GET', '/constraints/stats');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ safety: 1, quality: 1 });
  });

  it('GET /constraints/:id 200 / 404', async () => {
    const ok = await api('GET', '/constraints/c-quality');
    expect(ok.status).toBe(200);
    expect(ok.json.data.id).toBe('c-quality');
    const miss = await api('GET', '/constraints/nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Constraint not found');
  });

  it('POST /constraints/:id/degrade rejects safety layer (400)', async () => {
    const res = await api('POST', '/constraints/c-safe/degrade', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Cannot degrade safety-layer constraint');
  });

  it('POST /constraints/:id/degrade 404 / 200', async () => {
    const miss = await api('POST', '/constraints/nope/degrade', {});
    expect(miss.status).toBe(404);
    const ok = await api('POST', '/constraints/c-quality/degrade', {});
    expect(ok.status).toBe(200);
    expect(ok.json.degraded).toBe(true);
    expect(ok.json.data.id).toBe('c-quality');
  });

  it('POST /constraints/:id/rollback requires originalLevel', async () => {
    const bad = await api('POST', '/constraints/c-quality/rollback', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('originalLevel is required');
    const ok = await api('POST', '/constraints/c-quality/rollback', { originalLevel: 'L1' });
    expect(ok.status).toBe(200);
    expect(ok.json.rolledBack).toBe(true);
  });

  it('POST /constraints/:id/schedule validates safety + required fields', async () => {
    const safety = await api('POST', '/constraints/c-safe/schedule', { targetLevel: 'L3', reason: 'r' });
    expect(safety.status).toBe(400);
    expect(safety.json.error).toBe('Cannot schedule deprecation for safety-layer constraint');

    const bad = await api('POST', '/constraints/c-quality/schedule', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('targetLevel and reason are required');

    const ok = await api('POST', '/constraints/c-quality/schedule', { targetLevel: 'L3', reason: 'obsolete' });
    expect(ok.status).toBe(200);
    expect(ok.json.scheduled).toBe(true);
  });

  it('POST /check-constraints 400 without operation / 200 with', async () => {
    const bad = await api('POST', '/check-constraints', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('operation is required');

    const ok = await api('POST', '/check-constraints', { operation: 'create-requirement' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ passed: true, operation: 'create-requirement', violations: [] });
  });
});
