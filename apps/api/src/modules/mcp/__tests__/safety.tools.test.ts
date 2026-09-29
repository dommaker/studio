/**
 * safety.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 checkConstraint。handler 内动态 import 的 harness 直连 API
 * （checkConstraints）被 mock（#150 A5）。
 * 2026-08：checkGuardrail / getSandboxLevel 随 harness 1.2.0 删除
 * InputGuardrail/OutputGuardrail/Sandbox（ADR-0003）而移除，用例同删。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCheckConstraints } = vi.hoisted(() => ({
  mockCheckConstraints: vi.fn(),
}));

// importActual 展开保留公共类 ConstraintViolationError（instanceof 判据用真实类，
// mock 工厂只替换 checkConstraints 出入口）
vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, checkConstraints: mockCheckConstraints };
});

import { ConstraintViolationError } from '@dommaker/harness';
import { safetyTools } from '../safety.tools.js';

/** 生产形态违规样例（1.15.0 no_completion_without_verification 证据缺失判定） */
const violationResult = {
  id: 'no_completion_without_verification',
  severity: 'error',
  satisfied: false,
  message: '禁止无验证声明完成，必须有晚于最新变更的验证证据',
  evidence: ['未运行验证：.harness/evidence 无测试输出记录'],
  checkedAt: new Date(),
};

function tool(name: string) {
  const t = safetyTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

describe('safety.tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('导出 1 个 tool', () => {
    expect(safetyTools.map(t => t.name)).toEqual(['checkConstraint']);
  });

  it('checkConstraint 空 operation 直接返回 error，不调服务', async () => {
    const result = await tool('checkConstraint').handler({ operation: '  ' });
    expect(result).toEqual({ error: 'operation is required and must be non-empty', allowed: false });
    expect(mockCheckConstraints).not.toHaveBeenCalled();
  });

  it('checkConstraint 通过时返回 allowed=true 且无违规', async () => {
    mockCheckConstraints.mockResolvedValue({
      passed: true,
      errors: [{ satisfied: true }],
      warnings: [{ satisfied: true }],
    });
    const result = await tool('checkConstraint').handler({ operation: 'deploy', context: { roleId: 'r1' } });
    expect(mockCheckConstraints).toHaveBeenCalledWith({ roleId: 'r1', operation: 'deploy' });
    expect(result).toMatchObject({
      operation: 'deploy', allowed: true, violations: [], message: 'Constraint check passed',
    });
    expect(result.checkedAt).toBeTruthy();
  });

  it('checkConstraint 汇总未满足项并报告数量', async () => {
    // harness 1.10.0（ADR-0029）：结果桶为 errors/warnings（原 ironLaws/guidelines）
    mockCheckConstraints.mockResolvedValue({
      passed: false,
      errors: [{ satisfied: false, id: 'E1' }],
      warnings: [{ satisfied: false, id: 'W1' }],
    });
    const result = await tool('checkConstraint').handler({ operation: 'op' });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([{ satisfied: false, id: 'E1' }, { satisfied: false, id: 'W1' }]);
    expect(result.message).toBe('2 violation(s) found');
  });

  it('checkConstraint 剥离请求侧证据标志（#641）：自报标志不进入判定层并显式标注', async () => {
    mockCheckConstraints.mockResolvedValue({
      passed: true,
      errors: [{ satisfied: true }],
      warnings: [{ satisfied: true }],
    });
    const result = await tool('checkConstraint').handler({
      operation: 'deploy',
      context: { roleId: 'r1', hasPlanApproval: true, hasTest: false },
    });
    const received = mockCheckConstraints.mock.calls.at(-1)?.[0] ?? {};
    expect(received).toEqual({ roleId: 'r1', operation: 'deploy' });
    expect(result.strippedEvidenceFlags).toEqual(['hasPlanApproval', 'hasTest']);
    expect(result.allowed).toBe(true);
  });

  it('checkConstraint 约束违规以部分视图数据返回，不伪装 harnessUnavailable', async () => {
    // block 模式即抛即停：checkConstraints 对首个 error 级违规抛 ConstraintViolationError，
    // 违规必须回到数据面（allowed=false + 真实 id/message/evidence + 部分视图标注）
    mockCheckConstraints.mockRejectedValue(new ConstraintViolationError({ ...violationResult, checkedAt: new Date() }));
    const result = await tool('checkConstraint').handler({
      operation: 'code_implementation',
      context: { roleId: 'r1', hasTest: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.harnessUnavailable).toBeUndefined();
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      id: 'no_completion_without_verification',
      satisfied: false,
      message: violationResult.message,
      evidence: violationResult.evidence,
    });
    expect(result.violationPartialView).toMatchObject({ truncated: true });
    // #641 剥离标注在违规路径同样保留
    expect(result.strippedEvidenceFlags).toEqual(['hasTest']);
  });

  it('checkConstraint 非违规异常（真实调不通）才降级 harnessUnavailable', async () => {
    mockCheckConstraints.mockRejectedValue(new Error('down'));
    const result = await tool('checkConstraint').handler({ operation: 'op' });
    expect(result).toEqual({
      operation: 'op', allowed: false, harnessUnavailable: true,
      message: 'Harness unavailable, constraint check not performed',
    });
  });
});
