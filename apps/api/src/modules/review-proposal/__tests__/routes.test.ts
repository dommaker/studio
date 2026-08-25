/**
 * review-proposal/routes (#351) — 通用端点 HTTP 形状测试
 *
 * 取代 distill.routes 9 条同构端点：POST /:kind/:id/approve、POST /:kind/:id/reject、
 * GET /:kind/:id/status，kind 走注册表分发。注册内存假 adapter 验证：
 * 参数/状态码/响应体（含 skipped 200、not-pending 400、unknown-kind 404）。
 * STUDIO_AUTH=none（缺省）下 requireAuth/requireNotGuest 直通。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

import {
  registerReviewProposalAdapter,
  getReviewProposalAdapter,
  clearReviewProposalAdapters,
} from '../registry.js';

interface TestProposal {
  id: string;
  createdAt: string;
}

const { mockOnApprove, mockOnReject } = vi.hoisted(() => ({
  mockOnApprove: vi.fn(),
  mockOnReject: vi.fn(),
}));

let server: Server;
let base: string;
let tmpDir: string;

async function api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function store() {
  return getReviewProposalAdapter<TestProposal>('test')!.store;
}

async function seedProposal(id: string): Promise<void> {
  await store().appendProposal({ id, createdAt: new Date().toISOString() });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposal-routes-'));
  registerReviewProposalAdapter<TestProposal>({
    kind: 'test',
    cardType: 'test_proposal',
    storeNamespace: 'proposals',
    dataDir: tmpDir,
    fileStore: new FileStore(tmpDir),
    renderCardContent: p => ({ content: 'x', cardData: { proposalId: p.id } }),
    onApprove: mockOnApprove,
    onReject: mockOnReject,
  });
  const routes = (await import('../routes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/review-proposals', routes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/review-proposals`;
});

afterAll(async () => {
  clearReviewProposalAdapters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // 用例间提案隔离：清空墓碑文件
  fs.writeFileSync(path.join(tmpDir, 'proposals.jsonl'), '');
});

describe('POST /:kind/:id/approve', () => {
  it('执行成功 → 200 + success + onApprove data 透传', async () => {
    mockOnApprove.mockResolvedValue({ status: 'executed', data: { productIds: ['p1'] } });
    await seedProposal('p-1');
    const res = await api('POST', '/test/p-1/approve');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, productIds: ['p1'] });
    expect(mockOnApprove).toHaveBeenCalledTimes(1);
  });

  it('预算耗尽 skipped → 200 + success:false（提案保持 pending，不算错误）', async () => {
    mockOnApprove.mockResolvedValue({ status: 'pending', skipped: 'budget-exhausted' });
    await seedProposal('p-1');
    const res = await api('POST', '/test/p-1/approve');
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(false);
    expect(res.json.skipped).toBe('budget-exhausted');
  });

  it('执行失败 → 500', async () => {
    mockOnApprove.mockResolvedValue({ status: 'failed', error: 'provider timeout' });
    await seedProposal('p-1');
    const res = await api('POST', '/test/p-1/approve');
    expect(res.status).toBe(500);
    expect(res.json.error).toContain('provider timeout');
  });

  it('查无提案 → 400；非 pending → 400', async () => {
    mockOnApprove.mockResolvedValue({ status: 'executed' });
    expect((await api('POST', '/test/nope/approve')).status).toBe(400);
    await seedProposal('p-1');
    await api('POST', '/test/p-1/approve');
    const res = await api('POST', '/test/p-1/approve');
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('proposal-not-pending');
  });

  it('未知 kind → 404', async () => {
    const res = await api('POST', '/ghost/p-1/approve');
    expect(res.status).toBe(404);
    expect(res.json.error).toContain('unknown-kind');
  });
});

describe('POST /:kind/:id/reject', () => {
  it('拒绝成功 → 200 + onReject 调用', async () => {
    await seedProposal('p-1');
    const res = await api('POST', '/test/p-1/reject');
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(mockOnReject).toHaveBeenCalledTimes(1);
  });

  it('查无 / 非 pending → 400；未知 kind → 404', async () => {
    expect((await api('POST', '/test/nope/reject')).status).toBe(400);
    expect((await api('POST', '/ghost/p-1/reject')).status).toBe(404);
  });
});

describe('GET /:kind/:id/status', () => {
  it('返回提案状态；查无 → unknown', async () => {
    await seedProposal('p-1');
    const res = await api('GET', '/test/p-1/status');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, status: 'pending' });
    const missing = await api('GET', '/test/nope/status');
    expect(missing.json).toEqual({ success: true, status: 'unknown' });
  });

  it('未知 kind → 404', async () => {
    expect((await api('GET', '/ghost/p-1/status')).status).toBe(404);
  });
});
