/**
 * Requirement API 路由测试（vision §5.3）
 *
 * 挂载 createRequirementRoutes(tmpFileStore) 到 express app，
 * 监听临时端口后用 fetch 验证 happy paths + 校验错误。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { createRequirementRoutes } from '../requirement.routes.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-routes-test-'));
  fileStore = new FileStore(tmpDir);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/requirements', createRequirementRoutes(fileStore));
  // 与生产一致的兜底错误形状
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
  });

  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1/requirements`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Requirement API (vision §5.3)', () => {
  it('POST / creates a requirement (201 + REQ id)', async () => {
    const { status, json } = await api('POST', '/', { title: '手动需求', description: 'desc' });

    expect(status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('REQ-0001');
    expect(json.data.title).toBe('手动需求');
    expect(json.data.status).toBe('open');
    expect(json.data.createdBy).toBe('manual');
    expect(json.data.description).toBe('desc');
  });

  it('POST / without title → 400', async () => {
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: 123 }]) {
      const { status, json } = await api('POST', '/', body);
      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toContain('title');
    }
  });

  it('POST / with non-string-array docs → 400', async () => {
    const { status } = await api('POST', '/', { title: 'x', docs: ['ok', 1] });
    expect(status).toBe(400);
  });

  it('GET / lists requirements with filters', async () => {
    await api('POST', '/', { title: 'CH1 需求', channelId: 'ch-1' });
    await api('POST', '/', { title: 'CH2 需求', channelId: 'ch-2' });

    const all = await api('GET', '/');
    expect(all.status).toBe(200);
    expect(all.json.data.length).toBeGreaterThanOrEqual(3);

    const filtered = await api('GET', '/?channelId=ch-1');
    expect(filtered.json.data.length).toBe(1);
    expect(filtered.json.data[0].title).toBe('CH1 需求');

    const byStatus = await api('GET', '/?status=open');
    expect(byStatus.json.data.every((r: any) => r.status === 'open')).toBe(true);
  });

  it('GET / with invalid status → 400', async () => {
    const { status, json } = await api('GET', '/?status=bogus');
    expect(status).toBe(400);
    expect(json.error).toContain('status');
  });

  it('GET /:id returns the requirement; unknown → 404', async () => {
    const created = (await api('POST', '/', { title: '单个查询' })).json.data;

    const found = await api('GET', `/${created.id}`);
    expect(found.status).toBe(200);
    expect(found.json.data.id).toBe(created.id);

    const missing = await api('GET', '/REQ-9999');
    expect(missing.status).toBe(404);
    expect(missing.json.success).toBe(false);
  });

  it('PATCH /:id updates status/title/docs', async () => {
    const created = (await api('POST', '/', { title: '待更新' })).json.data;

    const { status, json } = await api('PATCH', `/${created.id}`, {
      status: 'in-progress',
      title: '已更新',
      docs: ['docs/a.md'],
    });
    expect(status).toBe(200);
    expect(json.data.status).toBe('in-progress');
    expect(json.data.title).toBe('已更新');
    expect(json.data.docs).toEqual(['docs/a.md']);
  });

  it('PATCH /:id invalid status / empty title / bad docs → 400; unknown → 404', async () => {
    const created = (await api('POST', '/', { title: '校验需求' })).json.data;

    expect((await api('PATCH', `/${created.id}`, { status: 'bogus' })).status).toBe(400);
    expect((await api('PATCH', `/${created.id}`, { title: '  ' })).status).toBe(400);
    expect((await api('PATCH', `/${created.id}`, { docs: 'not-array' })).status).toBe(400);
    expect((await api('PATCH', '/REQ-9999', { status: 'done' })).status).toBe(404);
  });

  it('GET /:id/chain returns requirement + workunit summaries', async () => {
    const created = (await api('POST', '/', { title: '链路需求' })).json.data;
    const wuService = new WorkUnitService(fileStore);
    const wu = await wuService.create({ scope: '链路任务', reqId: created.id, assigneeId: 'agent-9' });

    const { status, json } = await api('GET', `/${created.id}/chain`);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.requirement.id).toBe(created.id);
    expect(json.data.workunits).toEqual([
      { id: wu.id, title: '链路任务', status: 'unassigned', assigneeId: 'agent-9' },
    ]);
  });

  it('GET /:id/chain unknown → 404', async () => {
    const { status } = await api('GET', '/REQ-9999/chain');
    expect(status).toBe(404);
  });
});
