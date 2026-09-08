/**
 * traces.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（TraceCollector/TraceAnalyzer），
 * 挂载 tracesRoutes 覆盖：GET|POST /traces、GET /analysis、
 * GET /analysis/anomalies 的参数校验与正常链路。
 * （POST /diagnose 随 harness 1.2.0 ADR-0003 断链删除；
 * result=bypassed 随 bypass 记录 API 删除改为 400）
 * HOME 指向临时目录隔离 knowledge-bus 链路。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '@dommaker/studio-shared';

// 坏行计数由测试逐例控制；mock 只提供新报告入口 analyzeRecentReport，
// 旧入口 analyzeRecent 故意不 mock——路由若仍走旧入口会直接 TypeError，防假绿
let mockSkippedLines = 0;

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
    },
    TraceAnalyzer: class {
      constructor(_collector: unknown) {}
      analyzeRecentReport() {
        return {
          summaries: [{ constraintId: 'c1', passCount: 1, failCount: 0 }],
          skippedLines: mockSkippedLines,
        };
      }
      detectAnomalies() {
        return [{ constraintId: 'c1', type: 'high-failure-rate' }];
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

afterEach(() => {
  mockSkippedLines = 0;
  vi.restoreAllMocks();
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

  it('POST /traces records pass/fail', async () => {
    for (const result of ['pass', 'fail']) {
      const res = await api('POST', '/traces', { constraintId: 'c1', level: 'L1', result });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ recorded: true });
    }
  });

  it('POST /traces rejects bypassed (harness 1.2.0 removed bypass recording)', async () => {
    const res = await api('POST', '/traces', { constraintId: 'c1', level: 'L1', result: 'bypassed' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('no longer supported');
  });

  it('GET /analysis returns summaries + anomalies + skippedLines', async () => {
    const res = await api('GET', '/analysis?hours=1');
    expect(res.status).toBe(200);
    expect(res.json.totalSummaries).toBe(1);
    expect(res.json.totalAnomalies).toBe(1);
    expect(res.json.summaries).toHaveLength(1);
    expect(res.json.anomalies).toHaveLength(1);
    expect(res.json.skippedLines).toBe(0);
  });

  it('GET /analysis/anomalies returns anomaly list + skippedLines', async () => {
    const res = await api('GET', '/analysis/anomalies');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      data: [{ constraintId: 'c1', type: 'high-failure-rate' }],
      total: 1,
      skippedLines: 0,
    });
  });

  describe('skippedLines > 0 (corrupted traces.log lines, #451)', () => {
    it('GET /analysis returns partial results + skippedLines and logs a warn', async () => {
      mockSkippedLines = 1;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const res = await api('GET', '/analysis?hours=1');
      expect(res.status).toBe(200);
      expect(res.json.summaries).toEqual([{ constraintId: 'c1', passCount: 1, failCount: 0 }]);
      expect(res.json.skippedLines).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped'),
        expect.objectContaining({ skippedLines: 1 }),
      );
    });

    it('GET /analysis/anomalies passes skippedLines through and warns on the same chain', async () => {
      mockSkippedLines = 2;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const res = await api('GET', '/analysis/anomalies');
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual([{ constraintId: 'c1', type: 'high-failure-rate' }]);
      expect(res.json.total).toBe(1);
      expect(res.json.skippedLines).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped'),
        expect.objectContaining({ skippedLines: 2 }),
      );
    });

    it('logs no warn when nothing was skipped (zero noise)', async () => {
      mockSkippedLines = 0;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await api('GET', '/analysis');
      await api('GET', '/analysis/anomalies');
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
