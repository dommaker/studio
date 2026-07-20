/**
 * documents.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 documentsRoutes 到 express app，覆盖文档 CRUD/归档/审批全链路：
 * GET /（companyId 必填/过滤分页）、GET /detail/:documentId、GET /:projectId、
 * POST /:projectId（400/404/201）、PUT /:documentId、POST archive/approve/reject、
 * DELETE /:documentId。HOME 指向临时目录隔离真实 FileStore 数据。
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-docs-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  // 种子项目（POST /:projectId 依赖 ~/.studio/projects/<id>.json）
  const projectsDir = path.join(tmpHome, '.studio', 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, 'proj1.json'),
    JSON.stringify({ id: 'proj1', companyId: 'co1', pmoNumber: 'PMO-001', title: '项目一' }));

  const { documentsRoutes } = await import('../documents.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', documentsRoutes);

  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('documents.routes', () => {
  let docId: string;

  it('POST /:projectId 400 without type/title', async () => {
    const res = await api('POST', '/proj1', { type: 'design' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('type and title are required');
  });

  it('POST /:projectId 404 for unknown project', async () => {
    const res = await api('POST', '/nope', { type: 'design', title: 'X' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Project not found');
  });

  it('POST /:projectId 201 creates document', async () => {
    const res = await api('POST', '/proj1', { type: 'design', title: '架构设计', content: '正文', tags: ['a'] });
    expect(res.status).toBe(201);
    expect(res.json.companyId).toBe('co1');
    expect(res.json.status).toBe('active');
    expect(res.json.version).toBe(1);
    docId = res.json.id;
    expect(docId).toMatch(/^doc_/);
  });

  it('GET / 400 without companyId', async () => {
    const res = await api('GET', '/');
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('companyId is required');
  });

  it('GET / lists company documents with stats and Project enrichment', async () => {
    const res = await api('GET', '/?companyId=co1');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
    expect(res.json.documents[0].id).toBe(docId);
    expect(res.json.documents[0].Project).toEqual({ pmoNumber: 'PMO-001', title: '项目一' });
    expect(res.json.stats).toEqual({ design: 1 });
    const filtered = await api('GET', '/?companyId=co1&type=other');
    expect(filtered.json.total).toBe(0);
    const searched = await api('GET', '/?companyId=co1&search=架构');
    expect(searched.json.total).toBe(1);
  });

  it('GET /detail/:documentId returns doc, 404 for unknown', async () => {
    const res = await api('GET', `/detail/${docId}`);
    expect(res.status).toBe(200);
    expect(res.json.title).toBe('架构设计');
    expect(res.json.Project.pmoNumber).toBe('PMO-001');
    const missing = await api('GET', '/detail/doc_nope');
    expect(missing.status).toBe(404);
  });

  it('GET /:projectId lists project docs grouped by type with stats', async () => {
    const res = await api('GET', '/proj1');
    expect(res.status).toBe(200);
    expect(res.json.documents.length).toBe(1);
    expect(res.json.byType.design.length).toBe(1);
    expect(res.json.stats).toMatchObject({ total: 1, active: 1, archived: 0 });
  });

  it('PUT /:documentId updates fields and bumps version', async () => {
    const res = await api('PUT', `/${docId}`, { title: '架构设计v2', updatedBy: 'tester' });
    expect(res.status).toBe(200);
    expect(res.json.title).toBe('架构设计v2');
    expect(res.json.version).toBe(2);
    expect(res.json.updatedBy).toBe('tester');
    const missing = await api('PUT', '/doc_nope', { title: 'x' });
    expect(missing.status).toBe(404);
  });

  it('POST /:documentId/approve marks validated; /reject marks rejected; 404 for unknown', async () => {
    const approved = await api('POST', `/${docId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.json.status).toBe('validated');
    const rejected = await api('POST', `/${docId}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.json.status).toBe('rejected');
    expect((await api('POST', '/doc_nope/approve')).status).toBe(404);
    expect((await api('POST', '/doc_nope/reject')).status).toBe(404);
  });

  it('POST /:documentId/archive marks archived', async () => {
    const res = await api('POST', `/${docId}/archive`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('archived');
    expect(res.json.archivedAt).toBeTruthy();
    expect((await api('POST', '/doc_nope/archive')).status).toBe(404);
  });

  it('DELETE /:documentId soft-deletes and returns success', async () => {
    const res = await api('DELETE', `/${docId}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true });
    const detail = await api('GET', `/detail/${docId}`);
    expect(detail.json.status).toBe('deleted');
    // 删除不存在的文档同样返回 success（原有行为）
    expect((await api('DELETE', '/doc_nope')).json).toEqual({ success: true });
  });
});
