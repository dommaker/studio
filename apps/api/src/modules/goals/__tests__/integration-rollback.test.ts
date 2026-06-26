/**
 * Behavioral tests for B58: Integration failure diagnosis + phase rollback
 *
 * AC:
 * AC-1: parseIntegrationFailureType maps error string → IntegrationFailureType
 * AC-2: mapAffectedFilesToSteps maps file paths → GoalExecution step indices via git
 * AC-3: rollbackToIntegrationStep resets target step + downstream + integration(999)
 * AC-4: rollback increments retryCount (shared with MAX_RETRIES=3)
 * AC-5: multiple steps modifying same file → all rolled back
 * AC-6: rollbackCount ≥ 2 → mark blocked (prevent infinite loop)
 * AC-7: Gate failure → knowledgeBus.recordPattern()
 * AC-8: Downstream cascade follows dependency graph correctly
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ───

const {
  mockFindMany,
  mockFindUnique,
  mockUpdate,
  mockDelete,
  mockGoalUpdate,
  mockGoalPlanFindFirst,
  mockRecordPattern,
  mockExecSync,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockGoalUpdate: vi.fn(),
  mockGoalPlanFindFirst: vi.fn(),
  mockRecordPattern: vi.fn().mockResolvedValue(undefined),
  mockExecSync: vi.fn().mockReturnValue(''),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      update: mockUpdate,
      delete: mockDelete,
    },
    goalPlan: {
      findFirst: mockGoalPlanFindFirst,
    },
    goal: {
      update: mockGoalUpdate,
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  knowledgeBus: { recordPattern: mockRecordPattern },
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// Dynamic import after mocks
const {
  parseIntegrationFailureType,
  mapAffectedFilesToSteps,
  rollbackToIntegrationStep,
} = await import('../integration-rollback.js');

// ─── Helpers ───

/** Creates mock GoalExecution with id = exec-{stepIndex} */
function makeExec(stepIndex: number, status: string, overrides?: Record<string, unknown>) {
  return {
    id: `exec-${stepIndex}`,
    stepIndex,
    status,
    goalId: 'goal-1',
    retryCount: 0,
    input: JSON.stringify({ acGroup: { id: `ac-group-${stepIndex}`, files: [`src/step${stepIndex}.ts`] } }),
    ...overrides,
  };
}

function makePlan(steps: Array<{ index: number; dependencies: number[] }>) {
  return {
    id: 'plan-1',
    goalId: 'goal-1',
    status: 'approved',
    steps: JSON.stringify(steps.map(s => ({
      index: s.index,
      title: `step-${s.index}`,
      description: '',
      agentType: 'claude',
      input: {},
      dependencies: s.dependencies,
      estimatedDuration: '30m',
    }))),
  };
}

/** git log --format="%D" output format for a task branch */
function gitBranchOutput(execId: string): string {
  return `HEAD -> master, task/${execId}\n`;
}

/** git log output with multiple branches */
function gitMultiBranchOutput(execIds: string[]): string {
  return execIds.map(id => `HEAD -> master, task/${id}`).join('\n') + '\n';
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
  mockGoalUpdate.mockResolvedValue({});
  mockGoalPlanFindFirst.mockResolvedValue(null);
  mockRecordPattern.mockResolvedValue(undefined);
});

// ─── AC-1: parseIntegrationFailureType ───

describe('parseIntegrationFailureType', () => {
  test('returns merge_conflict for "Merge conflict on task/xxx"', () => {
    expect(parseIntegrationFailureType('Merge conflict on task/abc123: CONFLICT (content)')).toBe('merge_conflict');
  });

  test('returns tsc_error for "tsc failed: src/foo.ts(10,5)"', () => {
    expect(parseIntegrationFailureType('tsc failed: src/foo.ts(10,5): error TS2322')).toBe('tsc_error');
  });

  test('returns test_failure for "Impacted tests failed (3 tests)"', () => {
    expect(parseIntegrationFailureType('Impacted tests failed (vitest, 3 tests): Expected true to be false')).toBe('test_failure');
  });

  test('returns missing_branch for "No step branches found for merge"', () => {
    expect(parseIntegrationFailureType('No step branches found for merge. Missing: step 0')).toBe('missing_branch');
  });

  test('returns merge_conflict for error with "CONFLICT" in content', () => {
    expect(parseIntegrationFailureType('error: CONFLICT (content): Merge conflict in src/types.ts')).toBe('merge_conflict');
  });

  test('returns unknown for unrecognized error', () => {
    expect(parseIntegrationFailureType('something unexpected happened')).toBe('unknown');
  });

  test('returns unknown for empty error', () => {
    expect(parseIntegrationFailureType('')).toBe('unknown');
  });
});

// ─── AC-2: mapAffectedFilesToSteps ───

describe('mapAffectedFilesToSteps', () => {
  test('returns empty array when no succeeded executions', async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await mapAffectedFilesToSteps('goal-1', ['src/foo.ts'], '/tmp/repo');

    expect(result).toEqual([]);
  });

  test('maps file to step via git branch matching', async () => {
    mockFindMany.mockResolvedValue([
      makeExec(0, 'succeeded'),
      makeExec(1, 'succeeded'),
    ]);
    // git log --all --format="%D" output includes task/exec-0
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));

    const result = await mapAffectedFilesToSteps('goal-1', ['src/foo.ts'], '/tmp/repo');

    expect(result).toEqual([0]);
  });

  test('maps multiple files to multiple steps', async () => {
    mockFindMany.mockResolvedValue([
      makeExec(0, 'succeeded'),
      makeExec(1, 'succeeded'),
    ]);
    mockExecSync
      .mockReturnValueOnce(gitBranchOutput('exec-0'))  // src/foo.ts → exec-0
      .mockReturnValueOnce(gitBranchOutput('exec-1'));  // src/bar.ts → exec-1

    const result = await mapAffectedFilesToSteps('goal-1', ['src/foo.ts', 'src/bar.ts'], '/tmp/repo');

    expect(result).toEqual([0, 1]);
  });

  test('returns step only once when two files map to same step', async () => {
    mockFindMany.mockResolvedValue([makeExec(0, 'succeeded')]);
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));

    const result = await mapAffectedFilesToSteps('goal-1', ['src/foo.ts', 'src/foo.test.ts'], '/tmp/repo');

    expect(result).toEqual([0]);
  });

  test('skips file when git finds no matching branch', async () => {
    mockFindMany.mockResolvedValue([makeExec(0, 'succeeded')]);
    mockExecSync.mockReturnValue('HEAD -> master\n');  // no task branch

    const result = await mapAffectedFilesToSteps('goal-1', ['src/unknown.ts'], '/tmp/repo');

    expect(result).toEqual([]);
  });
});

// ─── AC-3,4,5,6,7,8: rollbackToIntegrationStep ───

describe('rollbackToIntegrationStep', () => {
  test('AC-3: rolls back target step and resets integration step (999)', async () => {
    // 1st findMany: all succeeded (used for execToStep map)
    mockFindMany.mockResolvedValueOnce([
      makeExec(0, 'succeeded'),
      makeExec(1, 'succeeded'),
    ]);
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));  // step 0 modified the file

    const result = await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed: src/step0.ts(5,10): error TS2322',
      affectedFiles: ['src/step0.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    expect(result.rolledBackSteps).toEqual([0]);

    // Target step (exec-0) should be reset to unassigned
    const stepResetCall = mockUpdate.mock.calls.find(
      (c: any) => c[0]?.where?.id === 'exec-0' && c[0]?.data?.status === 'unassigned'
    );
    expect(stepResetCall).toBeDefined();
    expect(stepResetCall[0].data.retryCount).toBe(1);
    expect(stepResetCall[0].data.error).toContain('tsc failed');

    // Integration step (999) should be deleted
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'exec-int' } });

    // Goal should be reset to active (via goalExecution.update with goalId)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'active', completedAt: null },
    });
  });

  test('AC-4: increments retryCount (shared with MAX_RETRIES)', async () => {
    mockFindMany.mockResolvedValueOnce([
      makeExec(0, 'succeeded', { retryCount: 1 }),
    ]);
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));

    await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed',
      affectedFiles: ['src/step0.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    const stepResetCall = mockUpdate.mock.calls.find(
      (c: any) => c[0]?.where?.id === 'exec-0' && c[0]?.data?.status === 'unassigned'
    );
    // retryCount was 1, should be incremented to 2
    expect(stepResetCall[0].data.retryCount).toBe(2);
  });

  test('AC-6: marks blocked when retryCount ≥ MAX_RETRIES', async () => {
    mockFindMany.mockResolvedValueOnce([
      makeExec(0, 'succeeded', { retryCount: 3 }),
    ]);
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));

    const result = await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed',
      affectedFiles: ['src/step0.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    expect(result.blocked).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'blocked' },
    });
    // Step should NOT be reset to unassigned
    const stepResetCall = mockUpdate.mock.calls.find(
      (c: any) => c[0]?.where?.id === 'exec-0' && c[0]?.data?.status === 'unassigned'
    );
    expect(stepResetCall).toBeUndefined();
  });

  test('AC-5: rolls back ALL steps modifying same file', async () => {
    mockFindMany.mockResolvedValueOnce([
      makeExec(0, 'succeeded'),
      makeExec(1, 'succeeded'),
    ]);
    // Both exec-0 and exec-1 modified src/shared.ts
    mockExecSync.mockReturnValue(gitMultiBranchOutput(['exec-0', 'exec-1']));

    const result = await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed',
      affectedFiles: ['src/shared.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    expect(result.rolledBackSteps).toEqual([0, 1]);

    // Both steps should be reset
    const resetCalls = mockUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'unassigned' && c[0]?.where?.id?.startsWith('exec-')
    );
    expect(resetCalls.length).toBe(2);
  });

  test('AC-8: cascades rollback to downstream dependent steps', async () => {
    // 1st findMany: all succeeded execs
    mockFindMany.mockResolvedValueOnce([
      makeExec(0, 'succeeded'),
      makeExec(1, 'succeeded'),
    ]);
    // Only step 0 modified the affected file
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));
    // Plan: step 1 depends on step 0
    mockGoalPlanFindFirst.mockResolvedValue(makePlan([
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
    ]));

    const result = await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed',
      affectedFiles: ['src/step0.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    // Both step 0 (direct) and step 1 (downstream) should be rolled back
    expect(result.rolledBackSteps).toContain(0);
    expect(result.rolledBackSteps).toContain(1);

    // Both steps should have status: unassigned update
    const resetCalls = mockUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'unassigned' && c[0]?.where?.id?.startsWith('exec-')
    );
    expect(resetCalls.length).toBe(2);
  });

  test('AC-7: records gate failure to knowledgeBus', async () => {
    mockFindMany.mockResolvedValueOnce([makeExec(0, 'succeeded')]);
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));

    await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed: src/step0.ts(5,10): error TS2322',
      affectedFiles: ['src/step0.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    expect(mockRecordPattern).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'incident',
        source: 'executor',
        severity: 'warning',
      })
    );
  });

  test('does not call knowledgeBus when rollback is blocked', async () => {
    mockFindMany.mockResolvedValueOnce([
      makeExec(0, 'succeeded', { retryCount: 3 }),
    ]);
    mockExecSync.mockReturnValue(gitBranchOutput('exec-0'));

    await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed',
      affectedFiles: ['src/step0.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    expect(mockRecordPattern).not.toHaveBeenCalled();
  });

  test('returns empty rolledBackSteps when no step can be identified', async () => {
    mockFindMany.mockResolvedValueOnce([makeExec(0, 'succeeded')]);
    mockExecSync.mockReturnValue('HEAD -> master\n');  // no task branch found

    const result = await rollbackToIntegrationStep({
      goalId: 'goal-1',
      integrationExecutionId: 'exec-int',
      failureType: 'tsc_error',
      error: 'tsc failed: unknown file',
      affectedFiles: ['src/mystery.ts'],
      worktree: '/tmp/worktrees/exec-int',
    });

    expect(result.rolledBackSteps).toEqual([]);
    // Integration step should still be deleted
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'exec-int' } });
  });
});
