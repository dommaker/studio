/**
 * diagnostics.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（ErrorClassifier/FailureRecorder/checkFile/
 * checkDirectory/generateReport/RulesBasedVerification），挂载 diagnosticsRoutes
 * 覆盖：POST /classify、POST /failures、POST /check-spec（file/dir 两支）、
 * POST /verify、GET /verify/rules。HOME 指向临时目录隔离 knowledge-bus 链路。
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
    ErrorClassifier: class {
      classify(err: Error) {
        return { type: 'unknown-error', message: err.message, name: err.name };
      }
      getLevel(type: string) {
        return type === 'unknown-error' ? 'L2' : 'L1';
      }
    },
    FailureRecorder: class {
      constructor(_opts: unknown) {}
      async record(record: unknown) {
        return record;
      }
    },
    checkFile: (filePath: string) => ({ file: filePath, errors: [], warnings: [] }),
    checkDirectory: (dirPath: string) => [
      { file: `${dirPath}/a.ts`, errors: [{ msg: 'e1' }], warnings: [] },
      { file: `${dirPath}/b.ts`, errors: [], warnings: [{ msg: 'w1' }] },
    ],
    generateReport: () => 'SPEC REPORT',
    RulesBasedVerification: class {
      constructor(_rules: unknown) {}
      async verifyAll() {
        return [{ rule: 'test', passed: true }];
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-diagnostics-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { diagnosticsRoutes } = await import('../diagnostics.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', diagnosticsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('diagnostics.routes', () => {
  it('POST /classify 400 without message / 200 classifies with level', async () => {
    const bad = await api('POST', '/classify', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('message is required');

    const ok = await api('POST', '/classify', { message: 'something broke', name: 'TypeError' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({
      type: 'unknown-error',
      message: 'something broke',
      name: 'TypeError',
      level: 'L2',
    });
  });

  it('POST /failures 400 without message / 200 records with defaults', async () => {
    const bad = await api('POST', '/failures', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('message is required');

    const ok = await api('POST', '/failures', { message: 'boom' });
    expect(ok.status).toBe(200);
    expect(ok.json.data.type).toBe('unknown');
    expect(ok.json.data.level).toBe('L1');
    expect(ok.json.data.message).toBe('boom');
    expect(typeof ok.json.data.timestamp).toBe('number');
  });

  it('POST /check-spec 400 without paths / 200 file branch', async () => {
    const bad = await api('POST', '/check-spec', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('filePath or dirPath is required');

    const ok = await api('POST', '/check-spec', { filePath: '/tmp/a.ts' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ file: '/tmp/a.ts', errors: [], warnings: [] });
  });

  it('POST /check-spec 200 directory branch with report + totals', async () => {
    const res = await api('POST', '/check-spec', { dirPath: '/tmp' });
    expect(res.status).toBe(200);
    expect(res.json.report).toBe('SPEC REPORT');
    expect(res.json.totalFiles).toBe(2);
    expect(res.json.totalErrors).toBe(1);
    expect(res.json.totalWarnings).toBe(1);
    expect(res.json.data).toHaveLength(2);
  });

  it('POST /verify 400 without rules array / 200 runs rules', async () => {
    const bad = await api('POST', '/verify', { rules: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('rules array is required');

    const ok = await api('POST', '/verify', { rules: [{ type: 'test' }], changedFiles: ['a.ts'] });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ data: [{ rule: 'test', passed: true }], passed: true, total: 1 });
  });

  it('GET /verify/rules returns 4 default rule types', async () => {
    const res = await api('GET', '/verify/rules');
    expect(res.status).toBe(200);
    expect(res.json.data).toHaveLength(4);
    expect(res.json.data.map((r: any) => r.type)).toEqual(['test', 'lint', 'typecheck', 'custom']);
  });
});
