/**
 * Behavioral tests for checkGoalCompletion()
 *
 * AC: step failed 且后续 step 依赖阻塞 → goal 标记 failed（不永远卡住）
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockWuFindMany, mockWuUpdate, mockWuCreate, mockWuFindUnique, mockWuUpdateMany } = vi.hoisted(() => ({
  mockWuFindMany: vi.fn(),
  mockWuUpdate: vi.fn(),
  mockWuCreate: vi.fn(),
  mockWuFindUnique: vi.fn(),
  mockWuUpdateMany: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: {
      findMany: mockWuFindMany,
      update: mockWuUpdate,
      create: mockWuCreate,
      findUnique: mockWuFindUnique,
      updateMany: mockWuUpdateMany,
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
 * Creates mock WorkUnit (child-level, formerly GoalExecution)
 * with metadata containing goalId and step info.
 */
function makeExec(stepIndex: number, status: string, overrides?: Record<string, any>) {
  return {
    id: `exec-${stepIndex}`,
    status,
    parentId: 'goal-1',
    retryCount: 0,
    metadata: JSON.stringify({
      goalId: 'goal-1',
      stepIndex,
      input: JSON.stringify({ acGroup: { id: `step-${stepIndex}` } }),
    }),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Creates mock WorkUnit with string-encoded acGroup dependencies
 * (no GoalPlan path — dependencies from acGroup.dependencies).
 */
function makeExecWithAcGroup(stepIndex: number, status: string, acGroup: Record<string, unknown>) {
  return {
    id: `exec-${stepIndex}`,
    status,
    parentId: 'goal-1',
    retryCount: 0,
    metadata: JSON.stringify({
      goalId: 'goal-1',
      stepIndex,
      input: JSON.stringify({ acGroup }),
    }),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWuUpdate.mockResolvedValue({});
  mockWuCreate.mockResolvedValue({});
  mockWuFindUnique.mockResolvedValue({ id: 'goal-1', status: 'active', metadata: JSON.stringify({ context: '{}' }) });
});

describe('checkGoalCompletion()', () => {
  test('marks goal closed when step 0 closed and steps 1-4 blocked by dependency', async () => {
    const workUnits = [
      makeExec(0, 'closed'),
      makeExec(1, 'unassigned'),
      makeExec(2, 'unassigned'),
      makeExec(3, 'unassigned'),
      makeExec(4, 'unassigned'),
    ];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    // Blocked steps should be marked as blocked
    const blockedUpdates = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.where?.id?.startsWith('exec-') && c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(4); // steps 1-4

    // Goal should be marked as closed
    expect(mockWuUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'closed', completedAt: expect.any(Date) },
    });
  });

  test('does not cascade when no dependencies exist (flat plan)', async () => {
    const workUnits = [
      makeExec(0, 'closed'),
      makeExec(1, 'unassigned'),
    ];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    // Step 1 should NOT be cascaded (no dependency — no acGroup.dependencies)
    // Goal should NOT be marked (step 1 still unassigned)
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not cascade when dependency succeeded', async () => {
    const workUnits = [
      makeExec(0, 'done'),
      makeExecWithAcGroup(1, 'unassigned', { id: 'step-1', dependencies: ['step-0'] }),
    ];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    // Step 1 should NOT be cascaded (dependency done)
    const blockedUpdates = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(0);
  });

  test('marks goal done when single step done', async () => {
    // Single step: skips integration step logic (regularSteps.length > 1)
    const workUnits = [makeExec(0, 'done')];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    expect(mockWuUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'done', completedAt: expect.any(Date) },
    });
  });

  test('handles chain dependency: step 0 closed → step 1 blocked → step 2 blocked', async () => {
    const workUnits = [
      makeExec(0, 'closed'),
      makeExecWithAcGroup(1, 'unassigned', { id: 'step-1', dependencies: ['step-0'] }),
      makeExecWithAcGroup(2, 'unassigned', { id: 'step-2', dependencies: ['step-1'] }),
    ];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    // Both step 1 and step 2 should be cascaded as blocked
    const blockedUpdates = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(2); // steps 1 and 2

    expect(mockWuUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'closed', completedAt: expect.any(Date) },
    });
  });

  test('cascades failure without GoalPlan (createGoalFromChannelDoc path)', async () => {
    // No GoalPlan — dependencies encoded in acGroup.dependencies (string IDs)
    const workUnits = [
      makeExecWithAcGroup(0, 'closed', { id: 'schema-migration' }),
      makeExecWithAcGroup(1, 'unassigned', { id: 'lifecycle-persist', dependencies: ['schema-migration'] }),
      makeExecWithAcGroup(2, 'unassigned', { id: 'crud-route', dependencies: ['schema-migration'] }),
    ];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    // Steps 1 and 2 should be cascaded as blocked
    const blockedUpdates = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'blocked'
    );
    expect(blockedUpdates.length).toBe(2);

    // Goal should be marked as closed
    expect(mockWuUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'closed', completedAt: expect.any(Date) },
    });
  });

  test('resets blocked steps when dependencies succeed (retry recovery)', async () => {
    // Step 0 done after retry, steps 1-2 were blocked
    const workUnits = [
      makeExecWithAcGroup(0, 'done', { id: 'schema-migration' }),
      makeExecWithAcGroup(1, 'blocked', { id: 'lifecycle-persist', dependencies: ['schema-migration'] }),
      makeExecWithAcGroup(2, 'blocked', { id: 'crud-route', dependencies: ['schema-migration'] }),
    ];
    mockWuFindMany.mockResolvedValue(workUnits);

    await checkGoalCompletion('goal-1');

    // Steps 1 and 2 should be reset to unassigned
    const resetUpdates = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'unassigned'
    );
    expect(resetUpdates.length).toBe(2);

    // Goal should NOT be marked as closed (steps are now unassigned)
    const goalCloseCalls = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.where?.id === 'goal-1' && c[0]?.data?.status === 'closed'
    );
    expect(goalCloseCalls.length).toBe(0);
  });
});

describe('updateStepExecution()', () => {
  test('passes failureType through to Prisma when provided', async () => {
    mockWuFindUnique.mockResolvedValue({ id: 'exec-1', metadata: JSON.stringify({ goalId: 'goal-1' }), status: 'closed' });
    mockWuUpdate.mockResolvedValue({ id: 'exec-1', status: 'closed', failureType: 'retryable' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'exit code 1', failureType: 'retryable' }, checkFn);

    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({
          failureType: 'retryable',
        }),
      })
    );
  });

  test('passes failureType=infrastructure to Prisma', async () => {
    mockWuFindUnique.mockResolvedValue({ id: 'exec-1', metadata: JSON.stringify({ goalId: 'goal-1' }), status: 'closed' });
    mockWuUpdate.mockResolvedValue({ id: 'exec-1', status: 'closed', failureType: 'infrastructure' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'worktree lost', failureType: 'infrastructure' }, checkFn);

    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureType: 'infrastructure' }),
      })
    );
  });

  test('passes failureType=not-retryable to Prisma', async () => {
    mockWuFindUnique.mockResolvedValue({ id: 'exec-1', metadata: JSON.stringify({ goalId: 'goal-1' }), status: 'closed' });
    mockWuUpdate.mockResolvedValue({ id: 'exec-1', status: 'closed', failureType: 'not-retryable' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'approach infeasible', failureType: 'not-retryable' }, checkFn);

    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureType: 'not-retryable' }),
      })
    );
  });

  test('works without failureType (backward compatible)', async () => {
    mockWuFindUnique.mockResolvedValue({ id: 'exec-1', metadata: JSON.stringify({ goalId: 'goal-1' }), status: 'closed' });
    mockWuUpdate.mockResolvedValue({ id: 'exec-1', status: 'closed' });
    const checkFn = vi.fn().mockResolvedValue(undefined);

    await updateStepExecution('exec-1', { status: 'failed', error: 'some error' }, checkFn);

    // failureType should NOT be in the data when not provided
    const calls = mockWuUpdate.mock.calls;
    const failureTypeCalls = calls.filter((c: any) => c[0]?.data?.failureType !== undefined);
    expect(failureTypeCalls.length).toBe(0);
  });
});
