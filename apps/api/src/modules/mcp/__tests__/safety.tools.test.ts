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

vi.mock('@dommaker/harness', () => ({
  checkConstraints: mockCheckConstraints,
}));

import { safetyTools } from '../safety.tools.js';

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
      ironLaws: [{ satisfied: true }],
      guidelines: [{ satisfied: true }],
    });
    const result = await tool('checkConstraint').handler({ operation: 'deploy', context: { roleId: 'r1' } });
    expect(mockCheckConstraints).toHaveBeenCalledWith({ roleId: 'r1', operation: 'deploy' });
    expect(result).toMatchObject({
      operation: 'deploy', allowed: true, violations: [], message: 'Constraint check passed',
    });
    expect(result.checkedAt).toBeTruthy();
  });

  it('checkConstraint 汇总未满足项并报告数量', async () => {
    // harness 1.x：tips 层已移除，违规聚合只剩 ironLaws + guidelines
    mockCheckConstraints.mockResolvedValue({
      passed: false,
      ironLaws: [{ satisfied: false, id: 'IL1' }],
      guidelines: [{ satisfied: false, id: 'G1' }],
    });
    const result = await tool('checkConstraint').handler({ operation: 'op' });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([{ satisfied: false, id: 'IL1' }, { satisfied: false, id: 'G1' }]);
    expect(result.message).toBe('2 violation(s) found');
  });

  it('checkConstraint 服务异常时降级 harnessUnavailable', async () => {
    mockCheckConstraints.mockRejectedValue(new Error('down'));
    const result = await tool('checkConstraint').handler({ operation: 'op' });
    expect(result).toEqual({
      operation: 'op', allowed: false, harnessUnavailable: true,
      message: 'Harness unavailable, constraint check not performed',
    });
  });
});
