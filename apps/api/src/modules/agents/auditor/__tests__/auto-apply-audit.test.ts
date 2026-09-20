/**
 * #591 B 类：auditor 低风险建议自动应用埋点（词表 auto_apply，落 audit-logs 轨）
 *
 * 每次运行共享一个 requestId（runId）；逐建议落一行：resource=建议 type、
 * 依据 = risk + detail 摘要（不落全 data payload）；应用失败 status=failure 不阻断后续建议。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decisionSpy, mockSkillUpdate } = vi.hoisted(() => ({
  decisionSpy: vi.fn(),
  mockSkillUpdate: vi.fn(),
}));

vi.mock('../../../audit-logs/agent-decision.js', () => ({ recordAgentDecision: decisionSpy }));
vi.mock('../../../skills/skill-store.js', () => ({
  skillStore: { update: mockSkillUpdate, get: vi.fn(), list: vi.fn(() => []) },
}));

import { applyLowRiskSuggestions } from '../auditor-execution.js';
import type { Suggestion } from '../auditor-rules.js';

function sug(overrides: Partial<Suggestion>): Suggestion {
  return {
    type: 'skill_weight',
    risk: 'low',
    detail: 'Skill X 成功率 30% 低于 50% 阈值，建议优化 prompt',
    ...overrides,
  } as Suggestion;
}

describe('applyLowRiskSuggestions 埋点（#591 auto_apply）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skill_weight 应用成功 → auto_apply 行（resource=type，依据=risk+摘要）', async () => {
    const applied = await applyLowRiskSuggestions([
      sug({ skillId: 'sk-1', skillName: 'X', data: { successRate: 0.3 } }),
    ]);

    expect(applied).toHaveLength(1);
    expect(mockSkillUpdate).toHaveBeenCalledWith('sk-1', { successRate: 0.3 });
    expect(decisionSpy).toHaveBeenCalledTimes(1);
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auto_apply',
      resource: 'skill_weight',
      resourceId: 'sk-1',
      status: 'success',
      details: expect.objectContaining({ risk: 'low', basis: expect.stringContaining('成功率') }),
      requestId: expect.any(String),
    }));
  });

  it('一次运行多条建议共享同一 requestId（runId）', async () => {
    await applyLowRiskSuggestions([
      sug({ skillId: 'sk-1', skillName: 'X', data: { successRate: 0.3 } }),
      sug({ type: 'skill_status', skillId: 'sk-2', skillName: 'Y', detail: 'draft 成功率 90%' }),
    ]);

    expect(decisionSpy).toHaveBeenCalledTimes(2);
    const [c1, c2] = decisionSpy.mock.calls.map(c => c[0]);
    expect(c1.requestId).toBe(c2.requestId);
    expect(c2.resource).toBe('skill_status');
  });

  it('circuit_fix 低风险（只记录不改）→ 同样落 auto_apply 行', async () => {
    await applyLowRiskSuggestions([
      sug({ type: 'circuit_fix', detail: '电路存在空节点，建议检查' }),
    ]);

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auto_apply',
      resource: 'circuit_fix',
      status: 'success',
    }));
  });

  it('应用抛错 → status=failure + error 摘要，不阻断后续建议', async () => {
    mockSkillUpdate.mockImplementationOnce(() => { throw new Error('write conflict'); });

    const applied = await applyLowRiskSuggestions([
      sug({ skillId: 'sk-bad', skillName: 'X', data: { successRate: 0.3 } }),
      sug({ type: 'skill_status', skillId: 'sk-ok', skillName: 'Y', detail: 'draft 成功率 90%' }),
    ]);

    expect(applied).toHaveLength(1); // 第二条仍应用成功
    expect(decisionSpy).toHaveBeenCalledTimes(2);
    expect(decisionSpy.mock.calls[0][0]).toMatchObject({ status: 'failure', resourceId: 'sk-bad' });
    expect(decisionSpy.mock.calls[0][0].details.error).toContain('write conflict');
    expect(decisionSpy.mock.calls[1][0]).toMatchObject({ status: 'success', resourceId: 'sk-ok' });
  });

  it('不在自动应用词表内的类型 → 不落账', async () => {
    await applyLowRiskSuggestions([sug({ type: 'param_tuning' })]);

    expect(decisionSpy).not.toHaveBeenCalled();
  });
});
