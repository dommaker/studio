/**
 * handleGoalFailed failureType routing tests
 *
 * AC B.2: handleGoalFailed reads failureType from GoalExecution, uses it for routing
 * AC B.3: select includes failureType
 * AC B.4: handleGoalFailed routes correctly based on failureType
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockGoalFindUnique,
  mockGoalUpdate,
  mockGoalExecutionFindMany,
  mockGoalExecutionFindUnique,
  mockGoalExecutionUpdate,
  mockFailureEventFindFirst,
  mockHandleAlert,
  mockClassifyFailureAction,
} = vi.hoisted(() => ({
  mockGoalFindUnique: vi.fn(),
  mockGoalUpdate: vi.fn(),
  mockGoalExecutionFindMany: vi.fn(),
  mockGoalExecutionFindUnique: vi.fn(),
  mockGoalExecutionUpdate: vi.fn(),
  mockFailureEventFindFirst: vi.fn(),
  mockHandleAlert: vi.fn(),
  mockClassifyFailureAction: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goal: {
      findUnique: mockGoalFindUnique,
      update: mockGoalUpdate,
    },
    goalExecution: {
      findMany: mockGoalExecutionFindMany,
      findUnique: mockGoalExecutionFindUnique,
      update: mockGoalExecutionUpdate,
    },
    failureEvent: {
      findFirst: mockFailureEventFindFirst,
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

vi.mock('../../shared/failure-classifier.js', () => ({
  classifyFailureAction: mockClassifyFailureAction,
}));

vi.mock('../../triage/triage-agent.js', () => ({
  triageAgent: { handleAlert: mockHandleAlert },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGoalFindUnique.mockResolvedValue({
    id: 'goal-1',
    title: 'Test Goal',
    status: 'running',
    context: '{}',
  });
  mockGoalExecutionFindMany.mockResolvedValue([]);
  mockFailureEventFindFirst.mockResolvedValue(null);
  mockClassifyFailureAction.mockReturnValue({ action: 'triage-agent', failureClass: 'unknown' });
  mockHandleAlert.mockResolvedValue(undefined);
  mockGoalExecutionUpdate.mockResolvedValue({});
  mockGoalExecutionFindUnique.mockResolvedValue(null);
  mockGoalUpdate.mockResolvedValue({});
});

import { handleGoalFailed } from '../goal-lifecycle.js';

describe('handleGoalFailed — failureType routing (B.2/B.3/B.4)', () => {
  test('B.3: reads failureType from failed GoalExecution', async () => {
    mockGoalExecutionFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'failed',
      failureType: 'retryable',
      goalId: 'goal-1',
      error: 'exit code 1',
      stepIndex: 0,
      updatedAt: new Date(),
    }]);

    await handleGoalFailed('goal-1');

    expect(mockGoalExecutionFindMany).toHaveBeenCalled();
  });

  test('B.2: uses failureType=infrastructure for retry instead of classifyFailureAction', async () => {
    mockGoalExecutionFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'failed',
      failureType: 'infrastructure',
      goalId: 'goal-1',
      error: 'worktree lost',
      stepIndex: 0,
      updatedAt: new Date(),
    }]);
    mockGoalExecutionFindUnique.mockResolvedValue({
      id: 'exec-1', status: 'failed', retryCount: 0, goalId: 'goal-1', error: 'worktree lost',
    });

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    expect(mockGoalExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending' }),
      })
    );
    expect(mockGoalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'executing' }),
      })
    );
  });

  test('B.2: uses failureType=retryable for retry', async () => {
    mockGoalExecutionFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'failed',
      failureType: 'retryable',
      goalId: 'goal-1',
      error: 'TypeError: undefined',
      stepIndex: 0,
      updatedAt: new Date(),
    }]);
    mockGoalExecutionFindUnique.mockResolvedValue({
      id: 'exec-1', status: 'failed', retryCount: 0, goalId: 'goal-1', error: 'TypeError: undefined',
    });

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    expect(mockGoalExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending' }),
      })
    );
  });

  test('B.2: uses failureType=not-retryable for mark-blocked (no retry, no triage)', async () => {
    mockGoalExecutionFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'failed',
      failureType: 'not-retryable',
      goalId: 'goal-1',
      error: 'approach infeasible',
      stepIndex: 0,
      updatedAt: new Date(),
    }]);

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    const pendingUpdates = mockGoalExecutionUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'pending'
    );
    expect(pendingUpdates.length).toBe(0);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });

  test('B.2: fallback to classifyFailureAction when failureType is null', async () => {
    mockGoalExecutionFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'failed',
      failureType: null,
      goalId: 'goal-1',
      error: 'some error',
      stepIndex: 0,
      updatedAt: new Date(),
    }]);
    mockClassifyFailureAction.mockReturnValue({ action: 'triage-agent', failureClass: 'unknown' });

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).toHaveBeenCalledWith('some error');
  });
});
