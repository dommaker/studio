/**
 * safety.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 checkConstraint / checkGuardrail / getSandboxLevel。
 * handler 内动态 import 的 constraintService / safetyService 被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckConstraints = vi.fn();
const mockInputCheck = vi.fn();
const mockOutputCheck = vi.fn();
const mockGetSandbox = vi.fn();

vi.mock('@dommaker/studio-shared', () => ({
  constraintService: { checkConstraints: mockCheckConstraints },
  safetyService: {
    getInputGuardrail: () => ({ check: mockInputCheck }),
    getOutputGuardrail: () => ({ check: mockOutputCheck }),
    getSandbox: mockGetSandbox,
  },
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

  it('导出 3 个 tool，注册顺序不变', () => {
    expect(safetyTools.map(t => t.name)).toEqual(['checkConstraint', 'checkGuardrail', 'getSandboxLevel']);
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

  it('checkGuardrail 默认 input 方向，content 截断到 200 字符', async () => {
    mockInputCheck.mockReturnValue({ safe: true, violations: [] });
    const long = 'x'.repeat(300);
    const result = await tool('checkGuardrail').handler({ content: long });
    expect(mockInputCheck).toHaveBeenCalledWith(long);
    expect(result).toMatchObject({
      direction: 'input', passed: true, violations: [], message: 'Guardrail check passed',
    });
    expect(result.content).toHaveLength(200);
  });

  it('checkGuardrail output 方向走 output guardrail；异常时降级', async () => {
    mockOutputCheck.mockReturnValue({ safe: false, violations: ['v1'] });
    const bad = await tool('checkGuardrail').handler({ direction: 'output', content: 'c' });
    expect(bad).toMatchObject({ direction: 'output', passed: false, message: '1 violation(s) found' });

    mockOutputCheck.mockImplementation(() => { throw new Error('down'); });
    const degraded = await tool('checkGuardrail').handler({ direction: 'output', content: 'c' });
    expect(degraded).toEqual({
      direction: 'output', passed: false, harnessUnavailable: true,
      message: 'Harness unavailable, guardrail check not performed',
    });
  });

  it('getSandboxLevel 返回 L{level}；异常时回退 L3', async () => {
    mockGetSandbox.mockReturnValue({ getLevel: () => 1, getDescription: () => 'full isolation' });
    expect(await tool('getSandboxLevel').handler({})).toEqual({
      level: 'L1', description: 'full isolation', message: 'Sandbox configuration retrieved',
    });

    mockGetSandbox.mockImplementation(() => { throw new Error('down'); });
    expect(await tool('getSandboxLevel').handler({})).toEqual({
      level: 'L3', message: 'Sandbox info unavailable (harness not loaded)',
    });
  });
});
