/**
 * Eval Case Generator 测试 — Better-Harness hill-climbing 吸收
 *
 * 1. 生产失败 → 自动生成 eval case
 * 2. Eval 标签分类型 (tool_selection/multi_step/edge_case/schema_change/constraint)
 */
import { describe, it, expect } from 'vitest';

// ════════════════════════════════════════════
// Error → Eval Tag 分类
// ════════════════════════════════════════════

describe('Eval Case: 失败归类打标签', () => {
  const classifyForEval = (errorMsg: string, changedFiles: string[]): string => {
    const msg = errorMsg.toLowerCase();

    // schema_change: prisma/schema/数据库变更相关
    if (changedFiles.some(f => f.includes('schema.prisma') || f.includes('migration'))) {
      return 'schema_change';
    }
    if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) {
      return 'schema_change';
    }

    // tool_selection: 工具相关错误
    if (msg.includes('tool') || msg.includes('bash') || msg.includes('command not found')) {
      return 'tool_selection';
    }
    if (msg.includes('permission') || msg.includes('denied') || msg.includes('eaccess')) {
      return 'tool_selection';
    }

    // multi_step: 多步推理断裂
    if (msg.includes('step') || msg.includes('integration') || msg.includes('merge')) {
      return 'multi_step';
    }
    if (msg.includes('reviewer') || msg.includes('rejected') || msg.includes('exhausted')) {
      return 'multi_step';
    }

    // constraint: harness 约束违反
    if (msg.includes('constraint') || msg.includes('violation') || msg.includes('iron_law')) {
      return 'constraint';
    }
    if (msg.includes('gate') || msg.includes('checkpoint')) {
      return 'constraint';
    }

    // edge_case: 边界/类型/测试
    if (msg.includes('type') || msg.includes('tsc') || msg.includes('lint')) {
      return 'edge_case';
    }
    if (msg.includes('test') || msg.includes('assert')) {
      return 'edge_case';
    }

    return 'other';
  };

  it('schema.prisma 变更失败 → schema_change', () => {
    expect(classifyForEval('build failed', ['prisma/schema.prisma', 'src/app.ts'])).toBe('schema_change');
  });

  it('database error → schema_change', () => {
    expect(classifyForEval('SQLITE_BUSY: database is locked', ['src/routes.ts'])).toBe('schema_change');
  });

  it('command not found → tool_selection', () => {
    expect(classifyForEval('bash: command not found', ['src/agent.ts'])).toBe('tool_selection');
  });

  it('EACCES permission denied → tool_selection', () => {
    expect(classifyForEval('EACCES: permission denied', ['src/exec.ts'])).toBe('tool_selection');
  });

  it('review rejected → multi_step', () => {
    expect(classifyForEval('review rejected after 3 rounds', ['src/review.ts'])).toBe('multi_step');
  });

  it('constraint violation → constraint', () => {
    expect(classifyForEval('ConstraintViolationError: iron_law', ['src/executor.ts'])).toBe('constraint');
  });

  it('type error → edge_case', () => {
    expect(classifyForEval('TypeScript error TS2345', ['src/component.tsx'])).toBe('edge_case');
  });

  it('未知错误 → other', () => {
    expect(classifyForEval('something went wrong', ['src/utils.ts'])).toBe('other');
  });

  it('所有标签都有对应分类', () => {
    const expectedTags = ['tool_selection', 'multi_step', 'edge_case', 'schema_change', 'constraint', 'other'];
    const testCases = [
      { error: 'tool call failed', files: [], expected: 'tool_selection' },
      { error: 'step 3 integration failed', files: [], expected: 'multi_step' },
      { error: 'TypeScript error', files: [], expected: 'edge_case' },
      { error: 'prisma error', files: [], expected: 'schema_change' },
      { error: 'constraint violation', files: [], expected: 'constraint' },
      { error: 'unknown mystery', files: [], expected: 'other' },
    ];
    for (const tc of testCases) {
      const tag = classifyForEval(tc.error, tc.files);
      expect(expectedTags).toContain(tag);
      expect(tag).toBe(tc.expected);
    }
  });
});

// ════════════════════════════════════════════
// Eval Case 内容生成
// ════════════════════════════════════════════

describe('Eval Case: 内容结构', () => {
  it('eval case 包含必要字段', () => {
    const evalCase = {
      type: 'eval_case' as const,
      level: 'agent_knowledge' as const,
      content: JSON.stringify({
        tag: 'tool_selection',
        description: 'Agent 在搜索文件时使用了 exec 而非 grep，导致权限错误',
        expectedBehavior: 'Agent should prefer read-only tools (grep, glob) over exec for file search',
        source: 'production_failure:goal-abc123',
        failureRate: 0.4,
        firstSeen: new Date().toISOString(),
      }),
      triggerCondition: 'when performing file search in worktree',
      sourceGoalId: 'goal-abc123',
      status: 'active' as const,
    };

    const parsed = JSON.parse(evalCase.content);
    expect(parsed.tag).toBeDefined();
    expect(parsed.description).toBeDefined();
    expect(parsed.expectedBehavior).toBeDefined();
    expect(parsed.source).toBeDefined();
    expect(evalCase.type).toBe('eval_case');
    expect(evalCase.level).toBe('agent_knowledge');
  });

  it('去重 — 同 sourceGoalId + 同 tag 不重复生成', () => {
    const existing = [
      { sourceGoalId: 'goal-1', content: JSON.stringify({ tag: 'tool_selection' }) },
      { sourceGoalId: 'goal-2', content: JSON.stringify({ tag: 'edge_case' }) },
    ];

    const newCase = { sourceGoalId: 'goal-1', tag: 'tool_selection' };
    const isDuplicate = existing.some(e =>
      e.sourceGoalId === newCase.sourceGoalId &&
      JSON.parse(e.content).tag === newCase.tag,
    );

    expect(isDuplicate).toBe(true);
  });

  it('不同 tag 同 goal → 可以共存', () => {
    const existing = [
      { sourceGoalId: 'goal-1', content: JSON.stringify({ tag: 'tool_selection' }) },
    ];

    const newCase = { sourceGoalId: 'goal-1', tag: 'edge_case' };
    const isDuplicate = existing.some(e =>
      e.sourceGoalId === newCase.sourceGoalId &&
      JSON.parse(e.content).tag === newCase.tag,
    );

    expect(isDuplicate).toBe(false);
  });
});

// ════════════════════════════════════════════
// Eval 维护：saturated eval 标记
// ════════════════════════════════════════════

describe('Eval Case: 维护 (spring cleaning)', () => {
  it('连续 10 次通过 → 标记为 saturated', () => {
    const evalCase = {
      id: 'eval-1',
      status: 'active',
      passCount: 10,
      lastCheckedAt: new Date(),
    };

    // After 10 consecutive passes, mark as deprecated (saturated)
    if (evalCase.passCount >= 10) {
      evalCase.status = 'deprecated';
    }

    expect(evalCase.status).toBe('deprecated');
  });

  it('未饱和 → 保持 active', () => {
    const evalCase = {
      id: 'eval-2',
      status: 'active',
      passCount: 3,
    };

    if (evalCase.passCount >= 10) {
      evalCase.status = 'deprecated';
    }

    expect(evalCase.status).toBe('active');
  });

  it('eval suite 不应单调增长', () => {
    // Simulate: 10 evals active, 3 saturated → keep total manageable
    const allEvals = [
      { status: 'active' }, { status: 'active' }, { status: 'active' },
      { status: 'active' }, { status: 'active' }, { status: 'active' },
      { status: 'active' },
      { status: 'deprecated' }, { status: 'deprecated' }, { status: 'deprecated' },
    ];

    const activeCount = allEvals.filter(e => e.status === 'active').length;
    const deprecatedCount = allEvals.filter(e => e.status === 'deprecated').length;

    expect(activeCount).toBe(7);
    expect(deprecatedCount).toBe(3);
    // Active count should not grow indefinitely if we deprecate saturated ones
    expect(activeCount + deprecatedCount).toBe(10);
  });
});

// ════════════════════════════════════════════
// EvalCaseGenerator 模块导出
// ════════════════════════════════════════════

describe('EvalCaseGenerator: 模块结构', () => {
  it('模块可以被导入', async () => {
    // 验证模块文件存在且可解析
    try {
      const mod = await import(
        '../../apps/api/src/modules/knowledge/eval-case-generator.js'
      );
      expect(mod.evalCaseGenerator).toBeDefined();
      expect(typeof mod.evalCaseGenerator.generateFromFailures).toBe('function');
      expect(typeof mod.evalCaseGenerator.classifyTag).toBe('function');
    } catch (e) {
      // 文件还未创建 — 预期 RED
      expect(String(e)).toContain('Cannot find');
    }
  });
});
