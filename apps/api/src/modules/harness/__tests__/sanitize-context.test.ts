/**
 * sanitizeConstraintContext 单元测试（#641）。
 *
 * has* 证据标志一律剥离（值为 undefined 的不算剥离），其余字段原样保留；
 * strippedFlags 按固定序返回，供响应面显式标注降级。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeConstraintContext, downgradeAnnotation, degradedChecksOf } from '../sanitize-context.js';

describe('sanitizeConstraintContext', () => {
  it('剥离全部 7 个证据标志，保留非证据字段', () => {
    const { context, strippedFlags } = sanitizeConstraintContext({
      operation: 'commit',
      projectPath: '/tmp/x',
      hasRootCauseInvestigation: true,
      hasPlanApproval: false,
      hasTest: true,
      hasFailingTest: false,
      hasReuseCheck: true,
      hasSingleTask: true,
      hasRequirement: true,
    });
    expect(context).toEqual({ operation: 'commit', projectPath: '/tmp/x' });
    expect(strippedFlags).toEqual([
      'hasRootCauseInvestigation',
      'hasPlanApproval',
      'hasTest',
      'hasFailingTest',
      'hasReuseCheck',
      'hasSingleTask',
      'hasRequirement',
    ]);
  });

  it('值为 undefined 的标志不算剥离', () => {
    const { context, strippedFlags } = sanitizeConstraintContext({
      operation: 'commit',
      hasTest: undefined,
    });
    expect(context).toEqual({ operation: 'commit', hasTest: undefined });
    expect(strippedFlags).toEqual([]);
  });

  it('无证据标志时不改动输入对象', () => {
    const input = { operation: 'commit', taskDescription: 't' };
    const { context, strippedFlags } = sanitizeConstraintContext(input);
    expect(context).toEqual(input);
    expect(context).not.toBe(input);
    expect(strippedFlags).toEqual([]);
  });
});

describe('downgradeAnnotation', () => {
  it('有剥离标志时返回响应标注字段，否则空对象', () => {
    expect(downgradeAnnotation(['hasTest'])).toEqual({ strippedEvidenceFlags: ['hasTest'] });
    expect(downgradeAnnotation([])).toEqual({});
  });
});

describe('degradedChecksOf', () => {
  it('从 errors/warnings 中收 skipped 项为降级清单（证据不可得第三态）', () => {
    const degraded = degradedChecksOf({
      passed: true,
      warningCount: 0,
      errors: [
        { id: 'a', severity: 'error', satisfied: true, skipped: true, skipReason: '变更清单未接线（context.changedFiles 缺失），无法判定证据新鲜度，本次未评估', checkedAt: new Date() },
        { id: 'b', severity: 'error', satisfied: true, checkedAt: new Date() },
      ],
      warnings: [
        { id: 'c', severity: 'warning', satisfied: true, skipped: true, checkedAt: new Date() },
      ],
    });
    expect(degraded).toEqual([
      { id: 'a', skipReason: '变更清单未接线（context.changedFiles 缺失），无法判定证据新鲜度，本次未评估' },
      { id: 'c', skipReason: undefined },
    ]);
  });
});
