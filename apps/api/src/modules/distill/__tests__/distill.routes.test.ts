/**
 * distill.routes (#143) — 蒸馏提案人审闸口端点测试
 *
 * getDistillService mock 成内存假服务（服务逻辑覆盖在 distill-service.test.ts）；
 * 本文件只验证 HTTP 形状：参数校验 / 状态码 / 响应体。
 * STUDIO_AUTH=none（缺省）下 requireAuth/requireNotGuest 直通。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { mockApprove, mockReject, mockGetProposalStatuses } = vi.hoisted(() => ({
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  mockGetProposalStatuses: vi.fn(),
}));

vi.mock('../distill-runtime.js', () => ({
  getDistillService: () => ({
    approve: mockApprove,
    reject: mockReject,
    getProposalStatuses: mockGetProposalStatuses,
  }),
}));

let server: Server;
let base: string;

async function api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  const routes = (await import('../distill.routes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/distill', routes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/distill`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /approve', () => {
  it('缺 proposalId → 400', async () => {
    const res = await api('POST', '/approve', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('proposalId');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('执行成功 → 200 + productIds', async () => {
    mockApprove.mockResolvedValue({ ok: true, productIds: ['p1'] });
    const res = await api('POST', '/approve', { proposalId: 'dp-1' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, productIds: ['p1'] });
    expect(mockApprove).toHaveBeenCalledWith('dp-1');
  });

  it('预算耗尽 → 200 + skipped（人可次日重试，不算错误）', async () => {
    mockApprove.mockResolvedValue({ ok: false, skipped: 'budget-exhausted' });
    const res = await api('POST', '/approve', { proposalId: 'dp-1' });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(false);
    expect(res.json.skipped).toBe('budget-exhausted');
  });

  it('提案非 pending → 400', async () => {
    mockApprove.mockResolvedValue({ ok: false, error: 'proposal-not-pending:executed' });
    const res = await api('POST', '/approve', { proposalId: 'dp-1' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('proposal-not-pending');
  });

  it('蒸馏执行失败 → 500', async () => {
    mockApprove.mockResolvedValue({ ok: false, error: 'provider timeout' });
    const res = await api('POST', '/approve', { proposalId: 'dp-1' });
    expect(res.status).toBe(500);
    expect(res.json.error).toContain('provider timeout');
  });
});

describe('POST /reject', () => {
  it('缺 proposalId → 400', async () => {
    const res = await api('POST', '/reject', {});
    expect(res.status).toBe(400);
  });

  it('拒绝成功 → 200', async () => {
    mockReject.mockResolvedValue({ ok: true });
    const res = await api('POST', '/reject', { proposalId: 'dp-1' });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
  });

  it('提案非 pending → 400', async () => {
    mockReject.mockResolvedValue({ ok: false, error: 'proposal-not-pending:rejected' });
    const res = await api('POST', '/reject', { proposalId: 'dp-1' });
    expect(res.status).toBe(400);
  });
});

describe('GET /proposal-status', () => {
  it('缺 ids → 400', async () => {
    const res = await api('GET', '/proposal-status');
    expect(res.status).toBe(400);
  });

  it('返回各提案状态（unknown 兜底）', async () => {
    mockGetProposalStatuses.mockResolvedValue({ 'dp-1': 'executed', 'dp-2': 'unknown' });
    const res = await api('GET', '/proposal-status?ids=dp-1,dp-2');
    expect(res.status).toBe(200);
    expect(res.json.statuses).toEqual({ 'dp-1': 'executed', 'dp-2': 'unknown' });
  });
});
