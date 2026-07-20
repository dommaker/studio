/**
 * dashboard.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（DashboardDataProvider + 内存态 FileKnowledgeStore/
 * KnowledgeQuery），挂载 dashboardRoutes 覆盖：GET /dashboard、GET /health。
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
    DashboardDataProvider: class {
      generate(entries: unknown[]) {
        return { generated: true, entryCount: entries.length };
      }
    },
    FileKnowledgeStore: class {
      constructor(_opts: unknown) {}
      list() {
        return [{ id: 'k1' }];
      }
    },
    KnowledgeQuery: class {
      constructor(_store: unknown) {}
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dashboard-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { dashboardRoutes } = await import('../dashboard.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', dashboardRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('dashboard.routes', () => {
  it('GET /dashboard returns generated dashboard from knowledge entries', async () => {
    const res = await api('GET', '/dashboard');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ generated: true, entryCount: 1 });
  });

  it('GET /health returns lightweight ok status', async () => {
    const res = await api('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok', harness: 'connected', constraintsActive: true });
  });
});
