/**
 * Goal → WorkUnit 转换测试
 *
 * 迁移计划: studio/docs/plans/goal-to-workunit-migration.md §1
 */

import { describe, it, expect } from 'vitest';
import {
  goalToWorkUnit,
  goalPlanToWorkUnits,
  goalExecutionToUpdate,
  convertGoalToWorkUnitTree,
} from '../goal-to-workunit.js';
import type { Goal, GoalPlan, GoalExecution } from '@prisma/client';

// ─── Fixtures ───

const mockGoal: Goal = {
  id: 'goal-1',
  title: 'Implement feature X',
  description: 'Add the new feature',
  status: 'executing',
  priority: 'high',
  constraints: '{"maxFiles": 5}',
  context: '{"branch": "feat/x"}',
  companyId: 'company-1',
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  completedAt: null,
};

const mockGoalPlan: GoalPlan = {
  id: 'plan-1',
  goalId: 'goal-1',
  status: 'executing',
  steps: JSON.stringify([
    {
      index: 0,
      title: 'Write tests',
      description: 'Create test cases',
      agentType: 'review',
      input: {},
      dependencies: [],
      estimatedDuration: '10m',
    },
    {
      index: 1,
      title: 'Implement code',
      description: 'Write implementation',
      agentType: 'executor',
      input: {},
      dependencies: [0],
      estimatedDuration: '20m',
    },
  ]),
  reasoning: 'Two-step approach',
  version: 1,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const mockExecution: GoalExecution = {
  id: 'exec-1',
  goalId: 'goal-1',
  planId: 'plan-1',
  stepIndex: 0,
  status: 'succeeded',
  agentType: 'review',
  input: '{"file": "test.ts"}',
  output: '{"result": "ok"}',
  error: null,
  failureType: null,
  retryCount: 0,
  startedAt: new Date('2026-01-01'),
  completedAt: new Date('2026-01-01'),
  timeoutAt: null,
  createdAt: new Date('2026-01-01'),
};

// ─── Tests ───

describe('goalToWorkUnit', () => {
  it('maps Goal fields to WorkUnit correctly', () => {
    const wu = goalToWorkUnit(mockGoal);

    expect(wu.type).toBe('task');
    expect(wu.scope).toBe('Implement feature X');
    expect(wu.status).toBe('active'); // executing → active
    expect(wu.metadata?.priority).toBe('high');
    expect(wu.metadata?.createdBy).toBe('user-1');
    expect(wu.metadata?.description).toBe('Add the new feature');
    expect(wu.metadata?.constraints).toBe('{"maxFiles": 5}');
    expect(wu.metadata?.context).toBe('{"branch": "feat/x"}');
  });

  it('maps all Goal statuses to WorkUnit statuses', () => {
    const cases: [string, string][] = [
      ['draft', 'unassigned'],
      ['planning', 'unassigned'],
      ['executing', 'active'],
      ['succeeded', 'done'],
      ['failed', 'closed'],
      ['blocked', 'blocked'],
    ];

    for (const [goalStatus, expectedWuStatus] of cases) {
      const wu = goalToWorkUnit({ ...mockGoal, status: goalStatus });
      expect(wu.status).toBe(expectedWuStatus);
    }
  });

  it('handles null optional fields', () => {
    const goal: Goal = {
      ...mockGoal,
      constraints: null,
      context: null,
      createdBy: null,
    };
    const wu = goalToWorkUnit(goal);

    expect(wu.metadata?.constraints).toBeUndefined();
    expect(wu.metadata?.context).toBeUndefined();
    expect(wu.metadata?.createdBy).toBeUndefined();
  });
});

describe('goalPlanToWorkUnits', () => {
  it('converts plan steps to child WorkUnits', () => {
    const children = goalPlanToWorkUnits(mockGoalPlan, 'parent-1');

    expect(children).toHaveLength(2);
    expect(children[0].scope).toBe('Write tests');
    expect(children[0].parentId).toBe('parent-1');
    expect(children[0].dependsOn).toEqual([]);
    expect(children[1].scope).toBe('Implement code');
    expect(children[1].dependsOn).toEqual(['parent-1-step-0']);
  });

  it('preserves plan metadata', () => {
    const children = goalPlanToWorkUnits(mockGoalPlan, 'parent-1');

    expect(children[0].metadata?.planVersion).toBe(1);
    expect(children[0].metadata?.planReasoning).toBe('Two-step approach');
    expect(children[0].metadata?.description).toBe('Create test cases');
  });

  it('returns empty array for invalid steps JSON', () => {
    const plan: GoalPlan = { ...mockGoalPlan, steps: 'invalid' };
    expect(goalPlanToWorkUnits(plan, 'parent-1')).toEqual([]);
  });

  it('returns empty array for empty steps', () => {
    const plan: GoalPlan = { ...mockGoalPlan, steps: '[]' };
    expect(goalPlanToWorkUnits(plan, 'parent-1')).toEqual([]);
  });
});

describe('goalExecutionToUpdate', () => {
  it('maps execution status correctly', () => {
    const update = goalExecutionToUpdate(mockExecution);
    expect(update.status).toBe('done'); // succeeded → done
  });

  it('maps failure fields', () => {
    const exec: GoalExecution = {
      ...mockExecution,
      status: 'failed',
      failureType: 'retryable',
      retryCount: 3,
      timeoutAt: new Date('2026-06-01'),
      error: 'Connection timeout',
    };
    const update = goalExecutionToUpdate(exec);

    expect(update.status).toBe('closed'); // failed → closed
    expect(update.failureType).toBe('retryable');
    expect(update.retryCount).toBe(3);
    expect(update.timeoutAt).toEqual(new Date('2026-06-01'));
    expect(update.metadata?.error).toBe('Connection timeout');
  });

  it('includes input/output in metadata', () => {
    const update = goalExecutionToUpdate(mockExecution);
    expect(update.metadata?.input).toBe('{"file": "test.ts"}');
    expect(update.metadata?.output).toBe('{"result": "ok"}');
  });

  it('omits empty metadata fields', () => {
    const exec: GoalExecution = {
      ...mockExecution,
      input: null,
      output: null,
      error: null,
    };
    const update = goalExecutionToUpdate(exec);
    expect(update.metadata).toBeUndefined();
  });
});

describe('convertGoalToWorkUnitTree', () => {
  it('converts full Goal with Plan and Executions', () => {
    const goal = {
      ...mockGoal,
      GoalPlan: [
        {
          ...mockGoalPlan,
          GoalExecution: [mockExecution],
        },
      ],
    };

    const tree = convertGoalToWorkUnitTree(goal);

    expect(tree.parent.scope).toBe('Implement feature X');
    expect(tree.children).toHaveLength(2);
    // First step should have 'done' status from execution
    expect(tree.children[0].status).toBe('done');
    // Second step should be unassigned (no execution)
    expect(tree.children[1].status).toBeUndefined();
  });

  it('handles Goal without Plan (direct Executions)', () => {
    const goal = {
      ...mockGoal,
      GoalPlan: undefined,
      GoalExecution: [mockExecution],
    };

    const tree = convertGoalToWorkUnitTree(goal);

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].status).toBe('done');
  });

  it('handles Goal with no Plan and no Executions', () => {
    const tree = convertGoalToWorkUnitTree(mockGoal);
    expect(tree.children).toEqual([]);
  });
});
