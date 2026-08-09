/**
 * constraints.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（getEffectiveConstraints + checkConstraints），
 * 挂载 constraintsRoutes 覆盖：GET /constraints、GET /constraints/stats、
 * GET /constraints/retired、GET /constraints/:id、POST rollback（config.yml 语义）、
 * POST /check-constraints。beforeAll chdir 到临时目录隔离 .harness/config.yml；
 * HOME 同样指向临时目录隔离 knowledge-bus 链路。
 * 注：degrade/schedule 端点及 ConstraintRegistry mock 已随 harness 0.17.0 移除（ADR-0001 决策 8）。
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
  const store = [
    { id: 'c-safe', kind: 'check', level: 'iron_law', rule: 'R1', message: 'm1', trigger: 'code_implementation', enforcement: 'test' },
    { id: 'c-quality', kind: 'prompt', level: 'guideline', rule: 'R2', message: 'm2', trigger: 'code_implementation', enforcement: 'custom' },
  ];
  return {
    ...actual,
    getEffectiveConstraints: () => store,
    checkConstraints: async (opts: { operation: string }) => ({
      passed: true,
      operation: opts.operation,
      violations: [],
    }),
  };
});

let tmpHome: string;
let prevHome: string | undefined;
let prevCwd: string;
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

function seedConfig(content: string): void {
  const dir = path.join(process.cwd(), '.harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yml'), content, 'utf-8');
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-constraints-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  prevCwd = process.cwd();
  process.chdir(tmpHome);

  const { constraintsRoutes } = await import('../constraints.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', constraintsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('constraints.routes', () => {
  it('GET /constraints lists effective set with kind', async () => {
    const res = await api('GET', '/constraints');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(res.json.data.map((c: any) => c.id).sort()).toEqual(['c-quality', 'c-safe']);
    expect(res.json.data[0]).toHaveProperty('kind');
  });

  it('GET /constraints/stats aggregates by kind/level (not shadowed by /:id)', async () => {
    const res = await api('GET', '/constraints/stats');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      total: 2,
      byKind: { check: 1, prompt: 1 },
      byLevel: { iron_law: 1, guideline: 1 },
    });
  });

  it('GET /constraints/retired returns [] without config.yml', async () => {
    const res = await api('GET', '/constraints/retired');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: [], total: 0 });
  });

  it('GET /constraints/retired lists retired metadata from config.yml', async () => {
    seedConfig([
      'constraints:',
      '  c-old:',
      '    enabled: false',
      '    retired:',
      '      at: "2026-08-01T00:00:00.000Z"',
      '      reason: "zero trigger"',
      '      stats: { total: 0, fail: 0, failRate: 0 }',
      '  c-active:',
      '    enabled: true',
      '',
    ].join('\n'));
    const res = await api('GET', '/constraints/retired');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
    expect(res.json.data[0].id).toBe('c-old');
    expect(res.json.data[0].retired.reason).toBe('zero trigger');
    fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
  });

  it('GET /constraints/:id 200 / 404', async () => {
    const ok = await api('GET', '/constraints/c-quality');
    expect(ok.status).toBe(200);
    expect(ok.json.data.id).toBe('c-quality');
    const miss = await api('GET', '/constraints/nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Constraint not found');
  });

  it('POST /constraints/:id/rollback 404 without config.yml entry', async () => {
    const miss = await api('POST', '/constraints/nope/rollback', {});
    expect(miss.status).toBe(404);
  });

  it('POST /constraints/:id/rollback deletes config.yml constraints.<id> section', async () => {
    seedConfig([
      'constraints:',
      '  c-old:',
      '    enabled: false',
      '    retired: { at: "2026-08-01T00:00:00.000Z", reason: "r", stats: { total: 0, fail: 0, failRate: 0 } }',
      'scenes: []',
      '',
    ].join('\n'));
    const ok = await api('POST', '/constraints/c-old/rollback', {});
    expect(ok.status).toBe(200);
    expect(ok.json.rolledBack).toBe(true);
    // c-old 不在 mock 生效集中 → data 为 null
    expect(ok.json.data).toBeNull();
    const written = fs.readFileSync(path.join(process.cwd(), '.harness', 'config.yml'), 'utf-8');
    expect(written).not.toContain('c-old');
    expect(written).toContain('scenes');
    fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
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
