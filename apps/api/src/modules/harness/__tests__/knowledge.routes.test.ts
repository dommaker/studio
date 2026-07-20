/**
 * knowledge.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（内存态 FileKnowledgeStore/KnowledgeQuery/
 * ReferenceTracker/KnowledgeLinter），挂载 knowledgeRoutes 覆盖：
 * POST /knowledge/query、GET /knowledge（含 TTL 缓存）、GET /knowledge/:id、
 * POST /knowledge、DELETE /knowledge/:id、POST /knowledge/lint。
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
  const entries = new Map<string, any>();
  return {
    ...actual,
    FileKnowledgeStore: class {
      constructor(_opts: unknown) {}
      list(filter?: Record<string, unknown>) {
        let all = [...entries.values()];
        if (filter?.type) all = all.filter(e => e.type === filter.type);
        return all;
      }
      get(id: string) {
        return entries.get(id);
      }
      save(entry: any) {
        entries.set(entry.id, entry);
      }
      delete(id: string) {
        return entries.delete(id);
      }
    },
    KnowledgeQuery: class {
      constructor(_store: unknown) {}
      query(budget: number, filter?: unknown) {
        return { entries: [...entries.values()], budget, filter };
      }
    },
    ReferenceTracker: class {
      constructor(_store: unknown) {}
    },
    KnowledgeLinter: class {
      constructor(_store: unknown, _tracker: unknown) {}
      run() {
        return { issues: [{ rule: 'no-refs', entryId: 'k-lint' }] };
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-knowledge-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { knowledgeRoutes } = await import('../knowledge.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', knowledgeRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('knowledge.routes', () => {
  it('POST /knowledge/query 400 without budget / 200 with', async () => {
    const bad = await api('POST', '/knowledge/query', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('budget is required');

    const ok = await api('POST', '/knowledge/query', { budget: 100 });
    expect(ok.status).toBe(200);
    expect(ok.json.data.budget).toBe(100);
  });

  it('GET /knowledge returns list (empty store, cached)', async () => {
    const res = await api('GET', '/knowledge');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: [], total: 0 });
    // 第二次命中缓存，响应一致
    const again = await api('GET', '/knowledge?type=pattern&limit=5');
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ data: [], total: 0 });
  });

  it('POST /knowledge 400 without required fields / 200 saves', async () => {
    const bad = await api('POST', '/knowledge', { id: 'k1' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('id, title, and content are required');

    const ok = await api('POST', '/knowledge', { id: 'k1', title: 'T', content: 'C', type: 'pattern' });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ saved: true, id: 'k1' });
  });

  it('GET /knowledge/:id 200 / 404', async () => {
    const ok = await api('GET', '/knowledge/k1');
    expect(ok.status).toBe(200);
    expect(ok.json.data.id).toBe('k1');
    expect(ok.json.data.maturity).toBe('draft');

    const miss = await api('GET', '/knowledge/nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Knowledge entry not found');
  });

  it('POST /knowledge/lint returns issues', async () => {
    const res = await api('POST', '/knowledge/lint', {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: [{ rule: 'no-refs', entryId: 'k-lint' }], total: 1 });
  });

  it('DELETE /knowledge/:id 404 / 200', async () => {
    const miss = await api('DELETE', '/knowledge/nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Knowledge entry not found');

    const ok = await api('DELETE', '/knowledge/k1');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ deleted: true });

    const gone = await api('GET', '/knowledge/k1');
    expect(gone.status).toBe(404);
  });
});
