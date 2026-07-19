/**
 * evolution.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 evolutionRoutes 到 express app，覆盖五个进化端点的参数校验（400）
 * 与空库下的 decay 衰减检查（200，无 LLM 调用）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evolution-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { evolutionRoutes } = await import('../evolution.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', evolutionRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('evolution.routes', () => {
  it('POST /evolution/micro 400 without required fields', async () => {
    const res = await api('POST', '/evolution/micro', { executionId: 'e1' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('executionId, projectId, companyId are required');
  });

  it('POST /evolution/meso 400 without projectId', async () => {
    const res = await api('POST', '/evolution/meso', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('projectId is required');
  });

  it('POST /evolution/macro 400 without companyId', async () => {
    const res = await api('POST', '/evolution/macro', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('companyId is required');
  });

  it('GET /evolution/health 400 without companyId', async () => {
    const res = await api('GET', '/evolution/health');
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('companyId is required');
  });

  it('POST /evolution/decay 200 on empty store', async () => {
    const res = await api('POST', '/evolution/decay', {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ results: [], total: 0 });
  });
});
