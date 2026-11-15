/**
 * entries.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 entriesRoutes 到 express app，覆盖：
 * POST /unified（400 缺字段 / 201 创建，applicableAgents → agent: 标签）、
 * GET /unified（列出创建的条目）、GET /gaps/:type（非法类型 400）。
 * HOME 指向临时目录隔离 sharedStore（~/.studio/knowledge）。
 * P4.2：/export /ask /gaps（统计概览）端点已删，对应用例随之摘除。
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

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-entries-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { entriesRoutes } = await import('../routes/entries.routes.js');
  const { requireAuth } = await import('../../../middleware/auth.js');
  const app = express();
  app.use(express.json());
  // P2-e：镜像 route-registry 挂载姿态（/api/v1/knowledge 挂 requireAuth）
  app.use('/api/v1/knowledge', requireAuth(), entriesRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('entries.routes', () => {
  it('POST /unified 400 when required fields missing', async () => {
    const res = await api('POST', '/unified', { type: 'guideline', title: 'T' });
    expect(res.status).toBe(400);
    // 契约驱动迁移（批次 4/7）：错误统一 `{ error: { code, message } }`（zod BAD_REQUEST）
    expect(res.json.error.code).toBe('BAD_REQUEST');
  });

  it('POST /unified 201 creates entry, applicableAgents stored as agent: tags', async () => {
    const res = await api('POST', '/unified', {
      type: 'guideline', title: '提交规范', content: '约定式提交',
      consumptionMode: 'reference', applicableAgents: ['executor'], tags: ['process'],
    });
    expect(res.status).toBe(201);
    // 契约驱动迁移（批次 4/7）：响应统一 `{ data }` 壳
    expect(res.json.data.id).toMatch(/^manual-/);
    expect(res.json.data.title).toBe('提交规范');
    expect(res.json.data.consumptionMode).toBe('reference');
  });

  it('POST /unified 201 后广播 knowledge.entry_changed（Step 2：他端 KnowledgePage 重拉信号）', async () => {
    const { eventBus } = await import('@dommaker/studio-shared');
    const received: any[] = [];
    const handler = (e: any) => { if (e?.event_type === 'knowledge.entry_changed') received.push(e); };
    eventBus.subscribe('events', handler);
    try {
      const res = await api('POST', '/unified', {
        type: 'pitfall', title: '广播条目', content: 'SSE 广播验证',
        consumptionMode: 'signal', tags: [],
      });
      expect(res.status).toBe(201);
      expect(received).toHaveLength(1);
      expect(received[0].data).toEqual({
        action: 'created', entryId: res.json.data.id, entryType: 'pitfall', title: '广播条目',
      });
    } finally {
      eventBus.unsubscribe('events', handler);
    }
  });

  it('GET /unified lists created entry (agent: tag preserved)', async () => {
    const res = await api('GET', '/unified');
    expect(res.status).toBe(200);
    const entries = res.json.data.entries ?? res.json.data;
    const found = (Array.isArray(entries) ? entries : []).find((e: any) => e.title === '提交规范');
    expect(found).toBeTruthy();
    expect(found.tags).toContain('agent:executor');
    expect(found.tags).toContain('process');
  });

  it('human entries are explicitly global and legacy scope can be completed', async () => {
    const created = await api('POST', '/unified', {
      type: 'guideline', title: '人工全局知识', content: '由操作员显式创建，因此具有可靠的人工来源。',
      consumptionMode: 'reference',
    });
    const { sharedStore } = await import('../knowledge-singletons.js');
    const learning = sharedStore.get(created.json.data.id).sourceReferences[0].learning;
    expect(learning.scope).toEqual({ kind: 'global' });
    expect(learning.outcome.execution).toBe('unknown');

    sharedStore.save({
      id: 'legacy-unknown', type: 'guideline', title: '旧知识', content: '保留浏览但暂停自动注入。',
      maturity: 'active', layer: 'project', created: new Date().toISOString(), lastReferenced: new Date().toISOString(),
      contributors: [], projects: [], tags: [], applicablePhases: [],
      sourceReferences: [{ workflow: 'legacy', timestamp: new Date().toISOString() }],
      referencedBy: [], executionResults: [], consumptionMode: 'signal', origin: 'agent',
    });
    const patched = await api('PATCH', '/unified/legacy-unknown', { scope: { kind: 'repo', id: '/repo/studio' } });
    expect(patched.status).toBe(200);
    expect(sharedStore.get('legacy-unknown').sourceReferences[0].learning.scope).toEqual({ kind: 'repo', id: '/repo/studio' });
    const overwrite = await api('PATCH', '/unified/legacy-unknown', { scope: { kind: 'global' } });
    expect(overwrite.status).toBe(409);
    expect(sharedStore.get('legacy-unknown').sourceReferences[0].learning.scope.kind).toBe('repo');
  });

  it('GET /gaps/:type 400 for invalid type', async () => {
    const res = await api('GET', '/gaps/bogus');
    expect(res.status).toBe(400);
    // 非法 type 原手写 400 → zod enum 400
    expect(res.json.error.code).toBe('BAD_REQUEST');
  });
});
