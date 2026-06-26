/**
 * Behavioral tests for checkGoalCompletion()
 *
 * AC: step failed 且后续 step 依赖阻塞 → goal 标记 failed（不永远卡住）
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGoalUpdate, mockGoalFindUnique, mockExecFindMany, mockExecUpdate, mockExecCreate, mockExecFindUnique } = vi.hoisted(() => ({
  mockGoalUpdate: vi.fn(),
  mockGoalFindUnique: vi.fn(),
  mockExecFindMany: vi.fn(),
  mockExecUpdate: vi.fn(),
  mockExecCreate: vi.fn(),
  mockExecFindUnique: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goal: {
      update: mockGoalUpdate,
      findUnique: mockGoalFindUnique,
    },
    goalExecution: {
      findMany: mockExecFindMany,
      update: mockExecUpdate,
      create: mockExecCreate,
      findUnique: mockExecFindUnique,
    },
    failureEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

vi.mock('../goal-review.js', () => ({
  handleGoalSucceeded: vi.fn(),
  findReviewWorktree: vi.fn(),
}));

import { checkGoalCompletion, updateStepExecution } from '../goal-lifecycle.js';

/**
 * Creates mock GoalExecution with direct columns.
 */
function makeExec(stepIndex: number, status: string, overrides?: Record<string, any>) {
  return {
    id: `exec-${stepIndex}`,
    status,
    goalId: 'goal-1',
    stepIndex,
    retryCount: 0,
    input: JSON.stringify({ acGroup: { id: `step-${stepIndex}` } }),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Creates mock GoalExecution with direct acGroup input.
 */
function makeExecWithAcGroup(stepIndex: number, status: string, acGroup: Record<string, unknown>) {
  return {
    id: `exec-${stepIndex}`,
    status,
    goalId: 'goal-1',
    stepIndex,
    retryCount: 0,
    input: JSON.stringify({ acGroup }),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecUpdate.mockResolvedValue({});
  mockExecCreate.mockResolvedValue({});
  mockGoalFindUnique.mockResolvedValue({ id: 'goal-1', status: 'running', title: 'Test Goal', context: '{}' });
});

describe('checkGoalCompletion()', () => {
  test('marks goal failed when step 0 failed and steps 1-4 blocked by dependency', async () => {
    const executions = [
      makeExec(0, 'failed'),
      makeExecWithAcGroup(1, 'pending', { id: 'step-1', dependencies: ['step-0'] }),
      makeExecWithAcGroup(2, 'pending', { id: 'step-2', dependencies: ['step-1'] }),
      makeExecWithAcGroup(3, 'pending', { id: 'step-3', dependencies: ['step-2'] }),
      makeExecWithAcGroup(4, 'pending', { id: 'step-4', dependencies: ['step-3'] }),
    ];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    const blockedUpdates = mockExecUpdate.mock.calls.filter(
      (c: any) => c[0]?.where?.id?.startsWith('exec-') && c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(4); // steps 1-4

    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });

  test('does not cascade when no dependencies exist (flat plan)', async () => {
    const executions = [
      makeExec(0, 'failed'),
      makeExec(1, 'pending'),
    ];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    // Step 1 should NOT be cascaded (no dependency — no acGroup.dependencies)
    // Goal should NOT be marked (step 1 still pending)
    expect(mockExecUpdate).not.toHaveBeenCalled();
  });

  test('does not cascade when dependency succeeded', async () => {
    const executions = [
      makeExec(0, 'succeeded'),
      makeExecWithAcGroup(1, 'pending', { id: 'step-1', dependencies: ['step-0'] }),
    ];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    // Step 1 should NOT be cascaded (dependency succeeded)
    const blockedUpdates = mockExecUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(0);
  });

  test('marks goal succeeded when single step succeeded', async () => {
    // Single step: skips integration step logic (regularSteps.length > 1)
    const executions = [makeExec(0, 'succeeded')];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'succeeded', completedAt: expect.any(Date) },
    });
  });

  test('handles chain dependency: step 0 failed → step 1 blocked → step 2 blocked', async () => {
    const executions = [
      makeExec(0, 'failed'),
      makeExecWithAcGroup(1, 'pending', { id: 'step-1', dependencies: ['step-0'] }),
      makeExecWithAcGroup(2, 'pending', { id: 'step-2', dependencies: ['step-1'] }),
    ];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    // Both step 1 and step 2 should be cascaded as blocked
    const blockedUpdates = mockExecUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(2); // steps 1 and 2

    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });

  test('cascades failure without GoalPlan (createGoalFromChannelDoc path)', async () => {
    // No GoalPlan — dependencies encoded in acGroup.dependencies (string IDs)
    const executions = [
      makeExecWithAcGroup(0, 'failed', { id: 'schema-migration' }),
      makeExecWithAcGroup(1, 'pending', { id: 'lifecycle-persist', dependencies: ['schema-migration'] }),
      makeExecWithAcGroup(2, 'pending', { id: 'crud-route', dependencies: ['schema-migration'] }),
    ];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    // Steps 1 and 2 should be cascaded as blocked
    const blockedUpdates = mockExecUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(2);

    // Goal should be marked as failed
    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });

  test('resets blocked steps when dependencies succeed (retry recovery)', async () => {
    // Step 0 succeeded after retry, steps 1-2 were blocked
    const executions = [
      makeExecWithAcGroup(0, 'succeeded', { id: 'schema-migration' }),
      makeExecWithAcGroup(1, 'blocked', { id: 'lifecycle-persist', dependencies: ['schema-migration'] }),
      makeExecWithAcGroup(2, 'blocked', { id: 'crud-route', dependencies: ['schema-migration'] }),
    ];
    mockExecFindMany.mockResolvedValue(executions);

    await checkGoalCompletion('goal-1');

    // Steps 1 and 2 should be reset to pending
    const resetUpdates = mockExecUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'pending'
    );
    expect(resetUpdates.length).toBe(2);

    // Goal should NOT be marked as failed (steps are now pending)
    const goalFailedCalls = mockGoalUpdate.mock.calls.filter(
      (c: any) => c[0]?.where?.id === 'goal-1' && c[0]?.data?.status === 'failed'
    );
    expect(goalFailedCalls.length).toBe(0);
  });
});

describe('updateStepExecution()', () => {
  test('passes failureType through to Prisma when provided', async () => {
    mockExecFindUnique.mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' });
    mockExecUpdate.mockResolvedValue({ id: 'exec-1', status: 'failed', failureType: 'retryable' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'exit code 1', failureType: 'retryable' }, checkFn);

    expect(mockExecUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({
          failureType: 'retryable',
        }),
      })
    );
  });

  test('passes failureType=infrastructure to Prisma', async () => {
    mockExecFindUnique.mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' });
    mockExecUpdate.mockResolvedValue({ id: 'exec-1', status: 'failed', failureType: 'infrastructure' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'worktree lost', failureType: 'infrastructure' }, checkFn);

    expect(mockExecUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureType: 'infrastructure' }),
      })
    );
  });

  test('passes failureType=not-retryable to Prisma', async () => {
    mockExecFindUnique.mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' });
    mockExecUpdate.mockResolvedValue({ id: 'exec-1', status: 'failed', failureType: 'not-retryable' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'approach infeasible', failureType: 'not-retryable' }, checkFn);

    expect(mockExecUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureType: 'not-retryable' }),
      })
    );
  });

  test('works without failureType (backward compatible)', async () => {
    mockExecFindUnique.mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' });
    mockExecUpdate.mockResolvedValue({ id: 'exec-1', status: 'failed' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'some error' }, checkFn);

    // failureType should NOT be in the data when not provided
    const calls = mockExecUpdate.mock.calls;
    const failureTypeCalls = calls.filter((c: any) => c[0]?.data?.failureType !== undefined);
    expect(failureTypeCalls.length).toBe(0);
  });
});
