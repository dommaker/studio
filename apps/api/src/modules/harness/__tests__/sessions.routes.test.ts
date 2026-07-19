/**
 * sessions.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（TokenEstimator/SessionManager），挂载 sessionsRoutes
 * 覆盖：POST /estimate-tokens、POST /sessions、POST /sessions/:id/events、
 * GET /sessions/:id、POST /sessions/:id/checkpoint（含未知会话 404）。
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
    TokenEstimator: class {
      static estimateText(text: string) {
        return text.length;
      }
      static estimateObject(obj: unknown) {
        return JSON.stringify(obj).length;
      }
    },
    SessionManager: class {
      private events = new Map<string, unknown[]>();
      createSession(id: string) {
        this.events.set(id, []);
        return { id, created: true };
      }
      appendToSession(id: string, event: unknown) {
        this.events.get(id)?.push(event);
      }
      getSessionInfo(id: string) {
        const evts = this.events.get(id);
        if (!evts) throw new Error('not found');
        return { id, eventCount: evts.length };
      }
      checkpointSession(id: string) {
        if (!this.events.has(id)) throw new Error('not found');
        return { id, checkpoint: true };
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sessions-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { sessionsRoutes } = await import('../sessions.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', sessionsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('sessions.routes', () => {
  it('POST /estimate-tokens 400 without text/object', async () => {
    const res = await api('POST', '/estimate-tokens', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('text or object is required');
  });

  it('POST /estimate-tokens estimates text and object', async () => {
    const text = await api('POST', '/estimate-tokens', { text: 'hello' });
    expect(text.status).toBe(200);
    expect(text.json).toEqual({ tokens: 5, method: 'character-based-estimate' });

    const obj = await api('POST', '/estimate-tokens', { object: { a: 1 } });
    expect(obj.status).toBe(200);
    expect(obj.json.tokens).toBe(JSON.stringify({ a: 1 }).length);
    expect(obj.json.method).toBe('character-based-estimate');
  });

  it('POST /sessions 400 without id / 200 creates', async () => {
    const bad = await api('POST', '/sessions', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('id is required');

    const ok = await api('POST', '/sessions', { id: 's1' });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ data: { id: 's1', created: true } });
  });

  it('POST /sessions/:id/events 400 without event / 404 unknown / 200 appends', async () => {
    const bad = await api('POST', '/sessions/s1/events', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('event is required');

    const miss = await api('POST', '/sessions/s2/events', { event: { type: 'x' } });
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Session not found: s2');

    const ok = await api('POST', '/sessions/s1/events', { event: { type: 'x' } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ recorded: true });
  });

  it('GET /sessions/:id 200 with info / 404 unknown', async () => {
    const ok = await api('GET', '/sessions/s1');
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ id: 's1', eventCount: 1 });

    const miss = await api('GET', '/sessions/s2');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Session not found: s2');
  });

  it('POST /sessions/:id/checkpoint 200 / 404 unknown', async () => {
    const ok = await api('POST', '/sessions/s1/checkpoint', {});
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ id: 's1', checkpoint: true });

    const miss = await api('POST', '/sessions/s2/checkpoint', {});
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Session not found: s2');
  });
});
