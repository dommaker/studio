/**
 * guards.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（InputGuardrail/OutputGuardrail/Sandbox），
 * 挂载 guardsRoutes 覆盖：POST /check-input、POST /check-output、GET /sandbox。
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
    InputGuardrail: class {
      check(input: string) {
        return { safe: true, input };
      }
    },
    OutputGuardrail: class {
      check(output: string) {
        return { safe: true, output };
      }
    },
    Sandbox: class {
      getLevel() {
        return 'standard';
      }
      getDescription() {
        return 'standard sandbox';
      }
      needsConfirmation() {
        return false;
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guards-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { guardsRoutes } = await import('../guards.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', guardsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('guards.routes', () => {
  it('POST /check-input 400 without input / 200 with', async () => {
    const bad = await api('POST', '/check-input', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('input is required');

    const ok = await api('POST', '/check-input', { input: 'hello' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ safe: true, input: 'hello' });
  });

  it('POST /check-output 400 without output / 200 with', async () => {
    const bad = await api('POST', '/check-output', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('output is required');

    const ok = await api('POST', '/check-output', { output: 'result text' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ safe: true, output: 'result text' });
  });

  it('GET /sandbox returns level + capabilities', async () => {
    const res = await api('GET', '/sandbox');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      level: 'standard',
      description: 'standard sandbox',
      needsConfirmation: false,
    });
  });
});
