/**
 * iron-laws.routes 证据标志信任边界测试（#641）。
 *
 * 被检查者不能自证：POST /check 与 /check-all 的 context 请求体不得携带
 * 证据标志（hasTest / hasPlanApproval 等）进入 harness 判定层——路由层剥离，
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

// importActual 展开保留公共类 ConstraintViolationError（instanceof 判据用真实类）
vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return {
    ...actual,
    getAllConstraints: vi.fn(() => []),
    getConstraint: vi.fn(),
    checkConstraint: mockCheckConstraint,
    checkConstraints: mockCheckConstraints,
  };
});

import { ConstraintViolationError } from '@dommaker/harness';

/** 生产形态违规样例（1.15.0 no_completion_without_verification 证据缺失判定） */
const violationResult = {
  id: 'no_completion_without_verification',
  severity: 'error',
  satisfied: false,
  message: '禁止无验证声明完成，必须有晚于最新变更的验证证据',
  evidence: ['未运行验证：.harness/evidence 无测试输出记录'],
  checkedAt: new Date(),
};

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
  it('POST /check-all：请求体自报 hasPlanApproval/hasTest=true 不进入判定层，响应标注降级', async () => {
    mockCheckConstraints.mockResolvedValue({ passed: true, errors: [], warnings: [], warningCount: 0 });
    const { status, json } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'commit', hasPlanApproval: true, hasTest: true, taskDescription: 'x' },
    });
    expect(status).toBe(200);
    const received = mockCheckConstraints.mock.calls.at(-1)?.[0] ?? {};
    expect(received.hasPlanApproval).toBeUndefined();
    expect(received.hasTest).toBeUndefined();
    expect(received.operation).toBe('commit');
    expect(received.taskDescription).toBe('x');
    expect(json.strippedEvidenceFlags).toEqual(['hasPlanApproval', 'hasTest']);
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

  it('POST /check-all：skip 的检查项在响应顶层 degradedChecks 显式标注（AC2 三态不可混淆）', async () => {
    mockCheckConstraints.mockResolvedValue({
      passed: true,
      errors: [
        { id: 'no_completion_without_verification', satisfied: true, skipped: true, skipReason: '变更清单未接线（context.changedFiles 缺失），无法判定证据新鲜度，本次未评估' },
        { id: 'docs_freshness', satisfied: true },
      ],
      warnings: [],
      warningCount: 0,
    });
    const { status, json } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'commit' },
    });
    expect(status).toBe(200);
    expect(json.degradedChecks).toEqual([
      { id: 'no_completion_without_verification', skipReason: '变更清单未接线（context.changedFiles 缺失），无法判定证据新鲜度，本次未评估' },
    ]);
    expect(json.strippedEvidenceFlags).toBeUndefined();
  });

  it('POST /check-all：无 skip 项时响应不带 degradedChecks', async () => {
    mockCheckConstraints.mockResolvedValue({
      passed: true,
      errors: [{ id: 'docs_freshness', satisfied: true }],
      warnings: [],
      warningCount: 0,
    });
    const { json } = await api('POST', '/api/v1/iron-laws/check-all', { context: { operation: 'commit' } });
    expect(json.degradedChecks).toBeUndefined();
  });

  it('POST /check：单约束与批量路径同样剥离证据标志', async () => {
    mockCheckConstraint.mockResolvedValue({ id: 'c1', satisfied: true });
    const single = await api('POST', '/api/v1/iron-laws/check', {
      lawId: 'no_completion_without_verification',
      context: { operation: 'commit', hasTest: true },
    });
    expect(single.status).toBe(200);
    const singleCtx = mockCheckConstraint.mock.calls.at(-1)?.[1] ?? {};
    expect(singleCtx.hasTest).toBeUndefined();
    expect(single.json.strippedEvidenceFlags).toEqual(['hasTest']);

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

/**
 * block 模式违规 → 数据（harness 1.15.0 证据源重构适配）：
 * checkConstraints 对首个 error 级违规抛 ConstraintViolationError（即抛即停），
 * 路由必须把违规转成部分视图数据返回，而不是 500；500 只留给真实调不通 harness。
 */
describe('iron-laws 路由 block 模式违规返回部分视图数据', () => {
  it('POST /check-all：ConstraintViolationError → 200 + data 含首个违规真实 id/message/evidence', async () => {
    mockCheckConstraints.mockRejectedValue(new ConstraintViolationError({ ...violationResult, checkedAt: new Date() }));
    const { status, json } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'code_implementation', projectPath: '/tmp/p' },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.passed).toBe(false);
    expect(json.data.errors).toHaveLength(1);
    expect(json.data.errors[0]).toMatchObject({
      id: 'no_completion_without_verification',
      severity: 'error',
      satisfied: false,
      message: violationResult.message,
      evidence: violationResult.evidence,
    });
    // 部分视图标注：即抛即停 = 仅首个违规，后续 error/warning 未执行
    expect(json.violationPartialView).toMatchObject({ truncated: true });
    expect(json.violationPartialView.reason).toBeTruthy();
  });

  it('POST /check-all：违规路径保留 #641 strippedEvidenceFlags 标注', async () => {
    mockCheckConstraints.mockRejectedValue(new ConstraintViolationError({ ...violationResult, checkedAt: new Date() }));
    const { status, json } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'code_implementation', hasTest: true },
    });
    expect(status).toBe(200);
    expect(json.strippedEvidenceFlags).toEqual(['hasTest']);
    const received = mockCheckConstraints.mock.calls.at(-1)?.[0] ?? {};
    expect(received.hasTest).toBeUndefined();
  });

  it('POST /check-all：非违规异常（真实调不通）仍 500', async () => {
    mockCheckConstraints.mockRejectedValue(new Error('down'));
    const { status } = await api('POST', '/api/v1/iron-laws/check-all', {
      context: { operation: 'code_implementation' },
    });
    expect(status).toBe(500);
  });

  it('POST /check：checkConstraint 不抛，违规结果原样走数据面（特征钉死，500 与本路径无关）', async () => {
    mockCheckConstraint.mockResolvedValue({ ...violationResult, checkedAt: new Date() });
    const { status, json } = await api('POST', '/api/v1/iron-laws/check', {
      lawId: 'no_completion_without_verification',
      context: { operation: 'code_implementation' },
    });
    expect(status).toBe(200);
    expect(json.data.satisfied).toBe(false);
    expect(json.data.id).toBe('no_completion_without_verification');
  });
});
