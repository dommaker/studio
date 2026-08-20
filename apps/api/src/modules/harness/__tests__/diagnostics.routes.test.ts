/**
 * diagnostics.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（ErrorClassifier/FailureRecorder），挂载 diagnosticsRoutes
 * 覆盖：POST /classify、POST /failures。
 * （/check-spec、/verify、/verify/rules 随 harness 1.2.0 ADR-0003 断链删除）
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
});
