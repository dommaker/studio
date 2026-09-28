/**
 * sanitizeConstraintContext 单元测试（#641）。
 *
 * has* 证据标志一律剥离（值为 undefined 的不算剥离），其余字段原样保留；
 * strippedFlags 按固定序返回，供响应面显式标注降级。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeConstraintContext } from '../sanitize-context.js';

describe('sanitizeConstraintContext', () => {
  it('剥离全部 8 个证据标志，保留非证据字段', () => {
    const { context, strippedFlags } = sanitizeConstraintContext({
      operation: 'commit',
      projectPath: '/tmp/x',
      hasRootCauseInvestigation: true,
      hasPlanApproval: false,
      hasVerificationEvidence: true,
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
      'hasVerificationEvidence',
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
      hasVerificationEvidence: undefined,
    });
    expect(context).toEqual({ operation: 'commit', hasVerificationEvidence: undefined });
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
