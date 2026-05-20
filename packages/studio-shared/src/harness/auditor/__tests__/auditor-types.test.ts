import { describe, it, expect } from 'vitest';
import {
  decideConstraintAction,
  DEFAULT_CONSUMPTION_RULES,
  type ConstraintEffectReport,
  type AuditorConclusion,
} from '../auditor-types';

describe('Auditor 协议', () => {
  // ── BP-013: 消费规则 ──

  it('verified + 高置信度 → 自动执行', () => {
    const rule = DEFAULT_CONSUMPTION_RULES[0];
    expect(rule.autoApply).toBe(true);
    expect(rule.requiresApproval).toBe(false);
  });

  it('observed + 低置信度 → 仅记录不操作', () => {
    const rule = DEFAULT_CONSUMPTION_RULES[3];
    expect(rule.autoApply).toBe(false);
    expect(rule.requiresApproval).toBe(false);
  });

  it('anomaly → 不自动操作', () => {
    const rule = DEFAULT_CONSUMPTION_RULES[4];
    expect(rule.autoApply).toBe(false);
    expect(rule.requiresApproval).toBe(false);
  });

  it('5 条消费规则有序排列', () => {
    expect(DEFAULT_CONSUMPTION_RULES).toHaveLength(5);
    // 按优先级排列
    const levels = DEFAULT_CONSUMPTION_RULES.map(r => r.level);
    expect(levels).toEqual(['verified', 'verified', 'observed', 'observed', 'anomaly']);
  });

  // ── BP-014: 约束效果评估 ──

  it('数据不足 → keep + 自动', () => {
    const report: ConstraintEffectReport = {
      constraintId: 'c1',
      changeType: 'level_change',
      changedAt: '2026-05-01',
      evaluationWindow: { start: '2026-05-01', end: '2026-05-07', totalExecutions: 3 },
      metrics: [{ metric: 'violation_rate', before: '?', after: '?', change: '?', direction: 'unchanged' }],
      verdict: 'insufficient_data',
      verdictReason: '缓存窗口不足',
    };
    const action = decideConstraintAction(report);
    expect(action.action).toBe('keep');
    expect(action.autoExecute).toBe(true);
  });

  it('明确退化 + 非新增约束 → 自动回滚', () => {
    const report: ConstraintEffectReport = {
      constraintId: 'c1',
      changeType: 'level_change',
      changedAt: '2026-05-01',
      evaluationWindow: { start: '2026-05-01', end: '2026-05-07', totalExecutions: 50 },
      metrics: [
        { metric: 'violation_rate', before: '5%', after: '18%', change: '+13%', direction: 'degraded' },
      ],
      verdict: 'rollback',
      verdictReason: '违反率从 5% 上升到 18%',
    };
    const action = decideConstraintAction(report);
    expect(action.action).toBe('rollback');
    expect(action.autoExecute).toBe(true);
  });

  it('新增约束失败 → 需审批回滚', () => {
    const report: ConstraintEffectReport = {
      constraintId: 'c1',
      changeType: 'new_constraint',
      changedAt: '2026-05-01',
      evaluationWindow: { start: '2026-05-01', end: '2026-05-07', totalExecutions: 50 },
      metrics: [{ metric: 'pass_rate', before: 'N/A', after: '60%', change: 'N/A', direction: 'degraded' }],
      verdict: 'rollback',
      verdictReason: '新约束导致通过率下降',
    };
    const action = decideConstraintAction(report);
    expect(action.action).toBe('rollback');
    expect(action.autoExecute).toBe(false); // 新增约束回滚需审批
  });

  it('需要调整 → 不自动', () => {
    const report: ConstraintEffectReport = {
      constraintId: 'c1',
      changeType: 'level_change',
      changedAt: '2026-05-01',
      evaluationWindow: { start: '2026-05-01', end: '2026-05-07', totalExecutions: 30 },
      metrics: [{ metric: 'violation_rate', before: '15%', after: '8%', change: '-7%', direction: 'improved' }],
      verdict: 'adjust',
      verdictReason: '改善但需微调阈值',
    };
    const action = decideConstraintAction(report);
    expect(action.action).toBe('adjust');
    expect(action.autoExecute).toBe(false);
  });

  it('改善 → keep + 自动', () => {
    const report: ConstraintEffectReport = {
      constraintId: 'c1',
      changeType: 'level_change',
      changedAt: '2026-05-01',
      evaluationWindow: { start: '2026-05-01', end: '2026-05-07', totalExecutions: 42 },
      metrics: [
        { metric: 'violation_rate', before: '23%', after: '2%', change: '-21%', direction: 'improved' },
      ],
      verdict: 'keep',
      verdictReason: '违反率从 23% 下降到 2%',
    };
    const action = decideConstraintAction(report);
    expect(action.action).toBe('keep');
    expect(action.autoExecute).toBe(true);
  });
});
