/**
 * agents.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（内存态 AgentLifecycle），挂载 agentsRoutes 覆盖：
 * POST /agents、POST /agents/:id/start|complete|fail、GET /agents、
 * GET /agents/:id（含未知 agent 404）。HOME 指向临时目录隔离 knowledge-bus 链路。
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
    AgentLifecycle: class {
      private states = new Map<string, any>();
      register(input: any) {
        const state = { ...input, status: 'registered' };
        this.states.set(input.id, state);
        return state;
      }
      start(id: string) {
        const s = this.states.get(id);
        if (!s) return null;
        s.status = 'running';
        return s;
      }
      complete(id: string, metadata?: unknown) {
        const s = this.states.get(id);
        if (!s) return null;
        s.status = 'completed';
        s.metadata = metadata;
        return s;
      }
      fail(id: string, error: string) {
        const s = this.states.get(id);
        if (!s) return null;
        s.status = 'failed';
        s.error = error;
        return s;
      }
      getAllStates() {
        return [...this.states.values()];
      }
      getState(id: string) {
        return this.states.get(id);
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { agentsRoutes } = await import('../agents.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', agentsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('agents.routes', () => {
  it('POST /agents 400 without id / 200 registers', async () => {
    const bad = await api('POST', '/agents', { type: 'coder' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('id is required');

    const ok = await api('POST', '/agents', { id: 'a1', type: 'coder', name: 'Agent 1', config: { role: 'dev' } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.id).toBe('a1');
    expect(ok.json.data.role).toBe('dev');
    expect(ok.json.data.status).toBe('registered');
  });

  it('POST /agents/:id/start 200 / 404', async () => {
    const ok = await api('POST', '/agents/a1/start', {});
    expect(ok.status).toBe(200);
    expect(ok.json.data.status).toBe('running');

    const miss = await api('POST', '/agents/nope/start', {});
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Agent not found');
  });

  it('POST /agents/:id/complete 200 with metadata / 404', async () => {
    const ok = await api('POST', '/agents/a1/complete', { metadata: { duration: 10 } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.status).toBe('completed');
    expect(ok.json.data.metadata).toEqual({ duration: 10 });

    const miss = await api('POST', '/agents/nope/complete', {});
    expect(miss.status).toBe(404);
  });

  it('POST /agents/:id/fail 200 (default error) / 404', async () => {
    const ok = await api('POST', '/agents/a1/fail', {});
    expect(ok.status).toBe(200);
    expect(ok.json.data.status).toBe('failed');
    expect(ok.json.data.error).toBe('Unknown error');

    const miss = await api('POST', '/agents/nope/fail', { error: 'boom' });
    expect(miss.status).toBe(404);
  });

  it('GET /agents lists all states', async () => {
    const res = await api('GET', '/agents');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
    expect(res.json.data[0].id).toBe('a1');
  });

  it('GET /agents/:id 200 / 404', async () => {
    const ok = await api('GET', '/agents/a1');
    expect(ok.status).toBe(200);
    expect(ok.json.data.id).toBe('a1');

    const miss = await api('GET', '/agents/nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Agent not found');
  });
});
