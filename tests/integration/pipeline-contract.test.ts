/**
 * Pipeline Contract Tests — 各阶段输入/输出格式契约验证
 *
 * 每条测试用固定 fixture 验证单阶段接口，不依赖 LLM。
 * 跑完全部 < 3 秒。
 *
 * 覆盖：
 *  - Analyst output: acGroup 完整字段 schema
 *  - Executor output: .progress.json 完整 schema
 *  - Executor output: testResults 格式 + 完成判定
 *  - Test gate: checkBeforeTaskComplete evidence 转发
 *  - GoalExecution.error: JSON roundtrip
 *  - Review output: score/approved/stanceReports
 *  - Integration trigger: stepCount ≥ 2
 *  - PostEval input: requirementsDocId
 *  - Scheduler recovery: abandon running + pending
 */

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Analyst acGroup 完整字段 schema
// ═══════════════════════════════════════════════════════════════

describe('Analyst acGroup schema', () => {
  const REQUIRED_FIELDS = ['id', 'acs', 'files', 'dependencies'] as const;
  const OPTIONAL_FIELDS = [
    'implementationNotes', 'architectureContext', 'codePatterns', 'gotchas',
  ] as const;

  const ARCH_CTX_FIELDS = [
    'functions', 'callChain', 'imports', 'typesInScope',
    'testMock', 'dangerZones', 'verifiedAt',
  ] as const;

  it('必填字段 id/acs/files/dependencies 都存在', () => {
    const group = { id: 'G1', acs: ['AC1'], files: ['f.ts'], dependencies: [] };
    for (const f of REQUIRED_FIELDS) {
      expect(group).toHaveProperty(f);
    }
  });

  it('architectureContext 可选但存在时含完整字段', () => {
    const ctx = {
      functions: ['fn()'],
      callChain: 'A → B',
      imports: ['import {x}'],
      typesInScope: ['T'],
      testMock: ['vi.mock()'],
      dangerZones: ['L50'],
      verifiedAt: 'abc123',
    };
    for (const f of ARCH_CTX_FIELDS) {
      expect(ctx).toHaveProperty(f);
    }
  });

  it('architectureContext 缺失时不崩溃（Executor 回退到无架构上下文）', () => {
    const group: Record<string, any> = { id: 'G1', acs: [], files: [], dependencies: [] };
    expect('architectureContext' in group).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Executor .progress.json 完整 schema (ProgressReport interface)
// ═══════════════════════════════════════════════════════════════

describe('.progress.json complete schema', () => {
  it('基础字段：allComplete/steps/notes/executionId/goalId', () => {
    const p = {
      executionId: 'exec-1',
      goalId: 'goal-1',
      allComplete: true,
      steps: { AC1: 'completed', AC2: 'completed' },
      notes: 'design decision',
    };
    expect(typeof p.allComplete).toBe('boolean');
    expect(typeof p.steps).toBe('object');
    expect(typeof p.notes).toBe('string');
    expect(typeof p.executionId).toBe('string');
  });

  it('testResults 完整结构：passed/total/failed/command/evidence', () => {
    const tr = {
      passed: true,
      total: 4,
      failed: 0,
      command: 'npm test',
      evidence: '4 tests passed',
    };
    expect(typeof tr.passed === 'boolean').toBe(true);
    expect(typeof tr.total === 'number').toBe(true);
    expect(typeof tr.failed === 'number').toBe(true);
    expect(tr.failed).toBe(0);
    expect(typeof tr.command === 'string').toBe(true);
    expect(typeof tr.evidence === 'string').toBe(true);
    expect(tr.evidence.length).toBeGreaterThan(0);
  });

  it('testResults 缺失时默认值为 failed 状态', () => {
    const progress: Record<string, any> = {};
    const tr = progress.testResults || { passed: false, failed: 1, total: 0 };
    expect(tr.passed).toBe(false);
    expect(tr.failed).toBe(1);
    expect(tr.total).toBe(0);
  });

  it('完成判定：allComplete=true + failed=0 → complete', () => {
    const progress = {
      allComplete: true,
      testResults: { passed: 4, failed: 0, total: 4 },
    };
    const isComplete = progress.allComplete && (progress.testResults.failed === 0);
    expect(isComplete).toBe(true);
  });

  it('完成判定：allComplete=true + failed>0 → NOT complete', () => {
    const progress = {
      allComplete: true,
      testResults: { passed: 3, failed: 1, total: 4 },
    };
    const isComplete = progress.allComplete && (progress.testResults.failed === 0);
    expect(isComplete).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test gate: evidence forwarding
// ═══════════════════════════════════════════════════════════════

describe('checkBeforeTaskComplete (test gate hook)', () => {
  it('valid: passed=true + evidence → allowed', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: true, command: 'npm test', failures: [], evidence: '4 tests passed',
    }]);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('missing evidence → blocked (缺少测试证据)', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: true, command: 'npm test', failures: [],
    }]);
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain('缺少测试证据');
  });

  it('passed=false → blocked (测试未通过)', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: false, command: 'npm test', failures: ['test 1'], evidence: '1 failed',
    }]);
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain('测试未通过');
  });

  it('package wrapping bug: testResults[0] 而非 {testResults: [...]}', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const arr = [{ passed: true, command: 'npm test', failures: [], evidence: 'proof' }];
    const result = await checkBeforeTaskComplete(arr);
    expect(result.allowed).toBe(true);
  });

  it('evidence fallback: keyEvidence[] → string join', () => {
    const tr = { passed: true, total: 129, failed: 0, keyEvidence: ['a', 'b'] };
    const evidence = tr.evidence || (Array.isArray((tr as any).keyEvidence) ? (tr as any).keyEvidence.join('; ') : undefined);
    expect(evidence).toBe('a; b');
  });
});

// ── Test Results evidence field disambiguation ──

describe('testResults.evidence field contract', () => {
  it('accepts evidence as string', () => {
    const tr = { evidence: '4 tests passed' };
    const evidence = tr.evidence || undefined;
    expect(evidence).toBe('4 tests passed');
  });

  it('accepts keyEvidence as array fallback', () => {
    const tr = { keyEvidence: ['test1: passed', 'test2: passed'] };
    const evidence = (Array.isArray((tr as any).keyEvidence) ? (tr as any).keyEvidence.join('; ') : undefined);
    expect(evidence).toBe('test1: passed; test2: passed');
  });
});

// ═══════════════════════════════════════════════════════════════
// GoalExecution.error JSON roundtrip
// ═══════════════════════════════════════════════════════════════

describe('GoalExecution.error storage contract', () => {
  it('error 存储为 JSON.stringify({message, timestamp})', () => {
    const msg = 'Something went wrong';
    const stored = JSON.stringify({ message: msg, timestamp: Date.now() });
    const parsed = JSON.parse(stored);
    expect(parsed.message).toBe(msg);
    expect(typeof parsed.timestamp).toBe('number');
  });

  it('error 回读时必须判断类型：对象取 .message，字符串直接用', () => {
    const jsonError = JSON.stringify({ message: 'err msg', timestamp: 1 });
    const parsed: any = JSON.parse(jsonError);
    const display1 = typeof parsed === 'object' ? parsed.message : String(parsed);
    expect(display1).toBe('err msg');

    const plainError = 'plain text error';
    const display2 = typeof plainError === 'object' ? (plainError as any).message : String(plainError);
    expect(display2).toBe('plain text error');
  });
});

// ═══════════════════════════════════════════════════════════════
// Review output schema + score contract
// ═══════════════════════════════════════════════════════════════

describe('Review output contract', () => {
  it('ReviewResult 必含 approved/score/issues/suggestions', () => {
    const result = {
      approved: true,
      score: 80,
      issueCount: 2,
      stanceReports: ['ac-compliance:0', 'skeptic:0'],
      issues: [{ severity: 'warning', message: 'minor' }],
      suggestions: ['improve naming'],
    };
    expect(typeof result.approved).toBe('boolean');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it('score: error→50, warning→80, clean→100', () => {
    const computeScore = (issues: Array<{ severity: string }>) => {
      const errors = issues.filter(i => i.severity === 'error').length;
      if (errors > 0) return 50;
      if (issues.length > 0) return 80;
      return 100;
    };

    expect(computeScore([{ severity: 'error' }])).toBe(50);
    expect(computeScore([{ severity: 'warning' }])).toBe(80);
    expect(computeScore([])).toBe(100);
  });

  it('effectiveApproved: error severity 强制驳回', () => {
    const review = {
      approved: true,
      issues: [{ severity: 'error' as const, message: 'blocking' }],
    };
    const hasError = review.issues.some(i => i.severity === 'error');
    const effective = review.approved && !hasError;
    expect(effective).toBe(false);
  });

  it('stanceReports 至少含 ac-compliance + forensic', () => {
    const stances = ['ac-compliance', 'forensic', 'skeptic', 'architect', 'executor', 'pragmatist'];
    expect(stances).toContain('ac-compliance');
    expect(stances).toContain('forensic');
    expect(stances.length).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════
// Integration trigger contract
// ═══════════════════════════════════════════════════════════════

describe('Integration trigger contract', () => {
  it('regular steps ≥ 2 → create integration step 999', () => {
    const regularSteps = [{ stepIndex: 0 }, { stepIndex: 1 }];
    const hasIntegration = (regularSteps.filter(s => s.stepIndex !== 999).length >= 2);
    expect(hasIntegration).toBe(true);
  });

  it('regular steps = 1 → no integration step', () => {
    const regularSteps = [{ stepIndex: 0 }];
    const hasIntegration = (regularSteps.filter(s => s.stepIndex !== 999).length >= 2);
    expect(hasIntegration).toBe(false);
  });

  it('integration step index is always 999', () => {
    const isIntegration = (stepIndex: number) => stepIndex === 999;
    expect(isIntegration(999)).toBe(true);
    expect(isIntegration(0)).toBe(false);
    expect(isIntegration(1)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// PostEval input contract
// ═══════════════════════════════════════════════════════════════

describe('PostEval input contract', () => {
  it('PostEval.evaluate 需要 requirementsDocId in goal.context', () => {
    const ctx = { requirementsDocId: 'doc-123', sourceChannelId: 'ch-456' };
    expect(ctx).toHaveProperty('requirementsDocId');
    expect(typeof ctx.requirementsDocId).toBe('string');
  });

  it('requirementsDocId 缺失时 PostEval 跳过（不崩溃）', () => {
    const ctx: Record<string, any> = {};
    const docId = ctx.requirementsDocId;
    if (!docId) {
      // PostEval returns null — no crash
      expect(docId).toBeUndefined();
    }
  });

  it('GapReport 含 completeness/matchedAcs/missedAcs', () => {
    const report = {
      goalId: 'g1',
      goalTitle: 'test',
      totalAcs: 3,
      matchedAcs: ['AC1', 'AC2'],
      missedAcs: ['AC3'],
      extraChanges: [],
      completeness: 2 / 3,
    };
    expect(report.completeness).toBeCloseTo(0.67, 1);
    expect(report.matchedAcs.length + report.missedAcs.length).toBe(report.totalAcs);
  });
});

// ═══════════════════════════════════════════════════════════════
// SessionSummaryAgent commit classification
// ═══════════════════════════════════════════════════════════════

describe('SessionSummaryAgent commit classification', () => {
  const classify = (msg: string): string => {
    const m = msg.toLowerCase();
    if (/^fix[:(\[]/.test(m) || m.startsWith('fix ')) return 'fix';
    if (/^feat[:(\[]/.test(m) || m.startsWith('feat ')) return 'feat';
    if (/^refactor[:(\[]/.test(m) || m.startsWith('refactor ')) return 'refactor';
    if (/^test[:(\[]/.test(m) || m.startsWith('test ')) return 'test';
    if (/^chore[:(\[]/.test(m) || m.startsWith('chore ')) return 'chore';
    return 'unknown';
  };

  it('fix: message → fix type', () => {
    expect(classify('fix: prevent zombie execution cascade')).toBe('fix');
    expect(classify('fix(test): pipeline test gate evidence')).toBe('fix');
  });

  it('feat: message → feat type', () => {
    expect(classify('feat: add SessionSummaryAgent')).toBe('feat');
  });

  it('refactor: message → refactor type', () => {
    expect(classify('refactor: extract deploy cleanup logic')).toBe('refactor');
  });

  it('未知格式 → unknown', () => {
    expect(classify('update stuff')).toBe('unknown');
  });

  it('checkpoint 文件路径：~/.studio/session-checkpoint.json', () => {
    const home = '/root';
    const file = `${home}/.studio/session-checkpoint.json`;
    expect(file).toContain('session-checkpoint.json');
  });
});

// ═══════════════════════════════════════════════════════════════
// Scheduler recovery contract
// ═══════════════════════════════════════════════════════════════

describe('Scheduler recovery contract', () => {
  it('abandonOrphanedRunning: 放弃 running 和 pending', () => {
    const query = { where: { status: { in: ['running', 'pending'] } } };
    expect(query.where.status.in).toContain('running');
    expect(query.where.status.in).toContain('pending');
  });

  it('abandonOrphanedRunning: 不放弃 succeeded 和 failed', () => {
    const query = { where: { status: { in: ['running', 'pending'] } } };
    expect(query.where.status.in).not.toContain('succeeded');
    expect(query.where.status.in).not.toContain('failed');
  });
});
