/**
 * proposals.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 proposalsRoutes 覆盖：GET /proposals、POST /proposals/:id/review、
 * POST /proposals/:id/execute（410 Gone）。
 * 注：POST /evolve、autoEvolve/ConstraintLifecycleRunner mock 已随 harness 0.17.0
 * 移除（ADR-0001 决策 8）——review 只更新状态，execute 恒 410。
 * 提案读写 process.cwd()/.harness/proposals —— beforeAll chdir 到临时目录隔离，
 * afterAll 恢复原 cwd；HOME 同样指向临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

function seedProposal(id: string, status: string): void {
  const dir = path.join(process.cwd(), '.harness', 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, status }));
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-proposals-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  prevCwd = process.cwd();
  process.chdir(tmpHome);

  const { proposalsRoutes } = await import('../proposals.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', proposalsRoutes);
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

describe('proposals.routes', () => {
  it('GET /proposals returns empty list when dir missing', async () => {
    const res = await api('GET', '/proposals');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: [], total: 0 });
  });

  it('POST /proposals/:id/review 400 when approved is not boolean', async () => {
    seedProposal('p1', 'pending');
    const res = await api('POST', '/proposals/p1/review', { approved: 'yes' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('approved (boolean) is required');
  });

  it('POST /proposals/:id/review 404 for unknown proposal', async () => {
    const res = await api('POST', '/proposals/nope/review', { approved: false });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Proposal not found: nope');
  });

  it('POST /proposals/:id/review reject marks rejected without execution', async () => {
    seedProposal('p2', 'pending');
    const res = await api('POST', '/proposals/p2/review', { approved: false, comment: 'no' });
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('rejected');
    expect(res.json.data.reviewComment).toBe('no');
    expect(res.json.executionResult).toBeNull();
  });

  it('POST /proposals/:id/review approve marks accepted (no auto-execution since 0.17.0)', async () => {
    seedProposal('p3', 'pending');
    const res = await api('POST', '/proposals/p3/review', { approved: true });
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('accepted');
    expect(res.json.executionResult).toBeNull();
  });

  it('POST /proposals/:id/execute 404 for unknown proposal', async () => {
    const res = await api('POST', '/proposals/nope/execute', {});
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Proposal not found: nope');
  });

  it('POST /proposals/:id/execute 410 Gone (auto-execution removed in 0.17.0)', async () => {
    seedProposal('p4', 'accepted');
    const res = await api('POST', '/proposals/p4/execute', {});
    expect(res.status).toBe(410);
    expect(res.json.error).toContain('harness 0.17.0');
  });
});
