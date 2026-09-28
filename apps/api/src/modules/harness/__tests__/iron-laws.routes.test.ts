/**
 * iron-laws.routes 证据标志信任边界测试（#641）。
 *
 * 被检查者不能自证：POST /check 与 /check-all 的 context 请求体不得携带
 * 证据标志（hasVerificationEvidence 等）进入 harness 判定层——路由层剥离，
 * 依赖这些标志的检查项由 harness 输入契约降级 skip（skipped + skipReason），
 * 响应以 strippedEvidenceFlags 显式标注降级。
 *
 * mock @dommaker/harness 的检查入口为 spy，断言收到的 context 不含证据标志。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { mockCheckConstraint, mockCheckConstraints } = vi.hoisted(() => ({
  mockCheckConstraint: vi.fn(),
  mockCheckConstraints: vi.fn(),
}));

vi.mock('@dommaker/harness', () => ({
  getAllConstraints: vi.fn(() => []),
  getConstraint: vi.fn(),
  checkConstraint: mockCheckConstraint,
  checkConstraints: mockCheckConstraints,
}));

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
  const { default: ironLawsRoutes } = await import('../iron-laws.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/iron-laws', ironLawsRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('iron-laws 路由证据标志信任边界（#641）', () => {
  it('POST /check-all：请求体自报 hasVerificationEvidence=true 不进入判定层，响应标注降级', async () => {
    mockCheckConstraints.mockResolvedValue({ passed: true, errors: [], warnings: [], warningCount: 0 });
    const { status, json } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'commit', hasVerificationEvidence: true, hasTest: true, taskDescription: 'x' },
    });
    expect(status).toBe(200);
    const received = mockCheckConstraints.mock.calls.at(-1)?.[0] ?? {};
    expect(received.hasVerificationEvidence).toBeUndefined();
    expect(received.hasTest).toBeUndefined();
    expect(received.operation).toBe('commit');
    expect(received.taskDescription).toBe('x');
    expect(json.strippedEvidenceFlags).toEqual(['hasVerificationEvidence', 'hasTest']);
  });

  it('POST /check-all：无证据标志时响应不带 strippedEvidenceFlags', async () => {
    mockCheckConstraints.mockResolvedValue({ passed: true, errors: [], warnings: [], warningCount: 0 });
    const { status, json } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'commit', projectPath: '/tmp/x' },
    });
    expect(status).toBe(200);
    const received = mockCheckConstraints.mock.calls.at(-1)?.[0] ?? {};
    expect(received).toEqual({ operation: 'commit', projectPath: '/tmp/x' });
    expect(json.strippedEvidenceFlags).toBeUndefined();
  });

  it('POST /check：单约束与批量路径同样剥离证据标志', async () => {
    mockCheckConstraint.mockResolvedValue({ id: 'c1', satisfied: true });
    const single = await api('POST', '/api/v1/iron-laws/check', {
      lawId: 'no_completion_without_verification',
      context: { operation: 'commit', hasVerificationEvidence: true },
    });
    expect(single.status).toBe(200);
    const singleCtx = mockCheckConstraint.mock.calls.at(-1)?.[1] ?? {};
    expect(singleCtx.hasVerificationEvidence).toBeUndefined();
    expect(single.json.strippedEvidenceFlags).toEqual(['hasVerificationEvidence']);

    const batch = await api('POST', '/api/v1/iron-laws/check', {
      lawId: ['a', 'b'],
      context: { operation: 'commit', hasPlanApproval: true },
    });
    expect(batch.status).toBe(200);
    const batchCtx = mockCheckConstraint.mock.calls.at(-1)?.[1] ?? {};
    expect(batchCtx.hasPlanApproval).toBeUndefined();
    expect(batch.json.strippedEvidenceFlags).toEqual(['hasPlanApproval']);
  });
});
