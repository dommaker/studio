/**
 * traces.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（TraceCollector/TraceAnalyzer/ConstraintDoctor），
 * 挂载 tracesRoutes 覆盖：GET|POST /traces、GET /analysis、
 * GET /analysis/anomalies、POST /diagnose 的参数校验与正常链路。
 * HOME 指向临时目录隔离 knowledge-bus 链路。
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
        return [{ constraintId: 'c1', level: 'L1', result: 'pass', timestamp: 1 }];
      }
      recordPass() {}
      recordFail() {}
      recordBypass() {}
    },
    TraceAnalyzer: class {
      constructor(_collector: unknown) {}
      analyzeRecent() {
        return [{ constraintId: 'c1', passes: 1, fails: 0 }];
      }
      detectAnomalies() {
        return [{ constraintId: 'c1', type: 'high-failure-rate' }];
      }
    },
    ConstraintDoctor: class {
      constructor(_opts: unknown) {}
      setData() {}
      async diagnose(anomaly: unknown) {
        return { anomaly, rootCause: 'test-cause' };
      }
    },
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-traces-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { tracesRoutes } = await import('../traces.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', tracesRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('traces.routes', () => {
  it('GET /traces returns data + total', async () => {
    const res = await api('GET', '/traces');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
    expect(res.json.data).toHaveLength(1);
  });

  it('GET /traces accepts filter query params', async () => {
    const res = await api('GET', '/traces?constraintId=c1&level=L1&result=pass&hours=12&limit=10');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
  });

  it('POST /traces 400 without required fields', async () => {
    const res = await api('POST', '/traces', { constraintId: 'c1' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('constraintId, level, and result are required');
  });

  it('POST /traces records pass/fail/bypassed', async () => {
    for (const result of ['pass', 'fail', 'bypassed']) {
      const res = await api('POST', '/traces', { constraintId: 'c1', level: 'L1', result });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ recorded: true });
    }
  });

  it('GET /analysis returns summaries + anomalies', async () => {
    const res = await api('GET', '/analysis?hours=1');
    expect(res.status).toBe(200);
    expect(res.json.totalSummaries).toBe(1);
    expect(res.json.totalAnomalies).toBe(1);
    expect(res.json.summaries).toHaveLength(1);
    expect(res.json.anomalies).toHaveLength(1);
  });

  it('GET /analysis/anomalies returns anomaly list', async () => {
    const res = await api('GET', '/analysis/anomalies');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: [{ constraintId: 'c1', type: 'high-failure-rate' }], total: 1 });
  });

  it('POST /diagnose 400 without anomaly', async () => {
    const res = await api('POST', '/diagnose', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('anomaly is required');
  });

  it('POST /diagnose returns diagnosis', async () => {
    const res = await api('POST', '/diagnose', { anomaly: { constraintId: 'c1' }, useLLM: false });
    expect(res.status).toBe(200);
    expect(res.json.data.rootCause).toBe('test-cause');
  });
});
