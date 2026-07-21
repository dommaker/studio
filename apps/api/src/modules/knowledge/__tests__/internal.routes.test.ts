/**
 * internal.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 internalRoutes 到 express app（对应 route-registry 的 /api/knowledge 无 auth 挂载），覆盖：
 * GET /sync-status（200，新鲜度检测结构）、
 * POST /upsert（400 缺字段 / 200 写入 KnowledgeStore + Document 投影 created→updated）、
 * POST /extract-text-sync（400 参数校验）。
 * HOME 指向临时目录隔离 sharedStore 与 FileStore。
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-internal-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { internalRoutes } = await import('../internal.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge', internalRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/knowledge`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('internal.routes', () => {
  it('GET /sync-status returns staleness report shape', async () => {
    const res = await api('GET', '/sync-status');
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('trackedScopes');
    expect(res.json).toHaveProperty('stale');
    expect(res.json).toHaveProperty('unmonitored');
    expect(res.json).toHaveProperty('healed');
  });

  it('POST /upsert 400 without scope/title/content', async () => {
    const res = await api('POST', '/upsert', { scope: 's' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('scope, title, and content are required');
  });

  it('POST /upsert creates then updates FileStore Document projection', async () => {
    const body = { scope: 'auth', title: '鉴权设计', content: 'v1 内容', projectId: 'p1', companyId: 'c1' };
    const created = await api('POST', '/upsert', body);
    expect(created.status).toBe(200);
    expect(created.json.prismaDocument.action).toBe('created');
    expect(created.json.prismaDocument.docId).toMatch(/^doc_/);
    expect(created.json).toHaveProperty('knowledgeStore');

    const updated = await api('POST', '/upsert', { ...body, content: 'v2 内容' });
    expect(updated.status).toBe(200);
    expect(updated.json.prismaDocument.action).toBe('updated');
    expect(updated.json.prismaDocument.docId).toBe(created.json.prismaDocument.docId);

    // 投影文档内容已更新且版本递增
    const docPath = path.join(tmpHome, '.studio', 'data', 'documents', `${created.json.prismaDocument.docId}.json`);
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf-8'));
    expect(doc.content).toBe('v2 内容');
    expect(doc.version).toBe(2);
    expect(doc.tags).toEqual(['auth', 'design-doc']);
  });

  it('POST /extract-text-sync 400 without content/source', async () => {
    const res = await api('POST', '/extract-text-sync', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('content and source are required');
  });
});
