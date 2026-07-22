/**
 * GET /:id/tree-tokens - 树级 token 开销聚合接口测试（AC-5.4）
 *
 * 覆盖：
 *  - 404：WU 不存在
 *  - 200：返回 TreeTokenReport 结构（rootId / nodes / rootTotal / budgetRemaining）
 *  - 200：无 collab metadata 时 rootId = WU 自身 id
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-tokens-route-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { default: router } = await import('../workunit.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workunits', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workunits`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /:id/tree-tokens (AC-5.4)', () => {
  it('404：WU 不存在', async () => {
    const res = await api('GET', '/nonexistent-wu/tree-tokens');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });

  it('200：返回 TreeTokenReport 结构', async () => {
    // 先创建一个 WU
    const createRes = await api('POST', '/', { scope: 'tree-tokens test' });
    expect(createRes.status).toBe(201);
    const wuId = createRes.json.id;

    const res = await api('GET', `/${wuId}/tree-tokens`);
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('rootId');
    expect(res.json).toHaveProperty('nodes');
    expect(res.json).toHaveProperty('rootTotal');
    expect(res.json).toHaveProperty('budgetRemaining');
    expect(Array.isArray(res.json.nodes)).toBe(true);
    // 无 collab metadata -> rootId = WU 自身
    expect(res.json.rootId).toBe(wuId);
    // 无事件 -> rootTotal = 0
    expect(res.json.rootTotal).toBe(0);
  });
});
