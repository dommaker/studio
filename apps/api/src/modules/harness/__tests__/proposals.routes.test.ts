/**
 * proposals.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（TraceCollector/TraceAnalyzer/ConstraintLifecycleRunner/
 * autoEvolve），挂载 proposalsRoutes 覆盖：GET /proposals、POST /evolve、
 * POST /proposals/:id/review、POST /proposals/:id/execute。
 * 提案读写 process.cwd()/.harness/proposals —— beforeAll chdir 到临时目录隔离，
 * afterAll 恢复原 cwd；HOME 同样指向临时目录。
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
  return {
    ...actual,
    TraceCollector: class {
      read() {
        return [{ constraintId: 'c1', result: 'fail' }];
      }
    },
    TraceAnalyzer: class {
      constructor(_collector: unknown) {}
      analyzeRecent() {
        return [{ constraintId: 'c1' }];
      }
      detectAnomalies() {
        return [{ constraintId: 'c1', type: 'anomaly' }];
      }
    },
    ConstraintLifecycleRunner: class {
      execute(proposal: { id: string }) {
        return { success: true, applied: [proposal.id] };
      }
    },
    autoEvolve: async () => ({
      diagnoses: [{ id: 'd1' }],
      proposals: [{ id: 'p-evolve', status: 'pending', constraintId: 'c1' }],
      autoApproved: 0,
      needsReview: ['p-evolve'],
      executions: [],
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

  it('POST /evolve runs pipeline and persists proposals', async () => {
    const res = await api('POST', '/evolve', { hours: 1 });
    expect(res.status).toBe(200);
    expect(res.json.data.anomalies).toBe(1);
    expect(res.json.data.diagnoses).toBe(1);
    expect(res.json.data.proposals).toBe(1);
    expect(res.json.data.needsReview).toEqual(['p-evolve']);
    // 提案已写入 .harness/proposals/p-evolve.json
    const saved = JSON.parse(fs.readFileSync(
      path.join(tmpHome, '.harness', 'proposals', 'p-evolve.json'), 'utf-8'));
    expect(saved.id).toBe('p-evolve');

    const list = await api('GET', '/proposals');
    expect(list.json.total).toBe(1);
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

  it('POST /proposals/:id/review approve auto-executes → implemented', async () => {
    seedProposal('p3', 'pending');
    const res = await api('POST', '/proposals/p3/review', { approved: true });
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('implemented');
    expect(res.json.executionResult).toEqual({ success: true, applied: ['p3'] });
  });

  it('POST /proposals/:id/execute 400 for non-executable status', async () => {
    const res = await api('POST', '/proposals/p2/execute', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Cannot execute proposal with status: rejected');
  });

  it('POST /proposals/:id/execute 404 for unknown proposal', async () => {
    const res = await api('POST', '/proposals/nope/execute', {});
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Proposal not found: nope');
  });

  it('POST /proposals/:id/execute runs accepted proposal → implemented', async () => {
    seedProposal('p4', 'accepted');
    const res = await api('POST', '/proposals/p4/execute', {});
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('implemented');
    expect(res.json.executionResult).toEqual({ success: true, applied: ['p4'] });
  });
});
