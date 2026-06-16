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
  mockGoalExecFindFirst,
  mockGoalExecFindUnique,
  mockGoalUpdate,
  mockExecUpdate,
  mockFailureEventFindFirst,
  mockHandleAlert,
  mockClassifyFailureAction,
} = vi.hoisted(() => ({
  mockGoalFindUnique: vi.fn(),
  mockGoalExecFindFirst: vi.fn(),
  mockGoalExecFindUnique: vi.fn(),
  mockGoalUpdate: vi.fn(),
  mockExecUpdate: vi.fn(),
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
      findFirst: mockGoalExecFindFirst,
      findUnique: mockGoalExecFindUnique,
      update: mockExecUpdate,
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

vi.mock('../failure-classifier.js', () => ({
  classifyFailureAction: mockClassifyFailureAction,
}));

vi.mock('../../triage/triage-agent.js', () => ({
  triageAgent: { handleAlert: mockHandleAlert },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGoalFindUnique.mockResolvedValue({ id: 'goal-1', title: 'Test Goal', context: {} });
  mockGoalExecFindFirst.mockResolvedValue(null);
  mockGoalExecFindUnique.mockResolvedValue(null);
  mockFailureEventFindFirst.mockResolvedValue(null);
  mockClassifyFailureAction.mockReturnValue({ action: 'triage-agent', failureClass: 'unknown' });
  mockHandleAlert.mockResolvedValue(undefined);
  mockGoalUpdate.mockResolvedValue({});
  mockExecUpdate.mockResolvedValue({});
});

import { handleGoalFailed } from '../goal-lifecycle.js';

describe('handleGoalFailed — failureType routing (B.2/B.3/B.4)', () => {
  test('B.3: select includes failureType when querying failed execution', async () => {
    mockGoalExecFindFirst.mockResolvedValue({
      id: 'exec-1', error: 'exit code 1', stepIndex: 0, failureType: 'retryable',
    });

    await handleGoalFailed('goal-1');

    // Verify the select query includes failureType
    expect(mockGoalExecFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { goalId: 'goal-1', status: 'failed' },
        select: expect.objectContaining({ failureType: true }),
      })
    );
  });

  test('B.2: uses failureType=infrastructure for retry instead of classifyFailureAction', async () => {
    mockGoalExecFindFirst.mockResolvedValue({
      id: 'exec-1', error: 'worktree lost', stepIndex: 0, failureType: 'infrastructure',
    });
    // retryGoalExecution needs findUnique to return the execution
    mockGoalExecFindUnique.mockResolvedValue({
      id: 'exec-1', goalId: 'goal-1', status: 'failed', input: '{}',
    });

    await handleGoalFailed('goal-1');

    // Should NOT call classifyFailureAction when failureType is present
    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    // retryGoalExecution calls findUnique, then handleGoalFailed resets goal to executing
    expect(mockGoalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'goal-1' },
        data: expect.objectContaining({ status: 'executing' }),
      })
    );
  });

  test('B.2: uses failureType=retryable for retry', async () => {
    mockGoalExecFindFirst.mockResolvedValue({
      id: 'exec-1', error: 'TypeError: undefined', stepIndex: 0, failureType: 'retryable',
    });
    mockGoalExecFindUnique.mockResolvedValue({
      id: 'exec-1', goalId: 'goal-1', status: 'failed', input: '{}',
    });

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    expect(mockGoalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'goal-1' },
        data: expect.objectContaining({ status: 'executing' }),
      })
    );
  });

  test('B.2: uses failureType=not-retryable for mark-blocked (no retry, no triage)', async () => {
    mockGoalExecFindFirst.mockResolvedValue({
      id: 'exec-1', error: 'approach infeasible', stepIndex: 0, failureType: 'not-retryable',
    });

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    // not-retryable → mark-blocked: no retry (no goal.update to 'executing'), no triage
    const goalUpdateCalls = mockGoalUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'executing'
    );
    expect(goalUpdateCalls.length).toBe(0);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });

  test('B.2: fallback to classifyFailureAction when failureType is null', async () => {
    mockGoalExecFindFirst.mockResolvedValue({
      id: 'exec-1', error: 'some error', stepIndex: 0, failureType: null,
    });
    mockClassifyFailureAction.mockReturnValue({ action: 'triage-agent', failureClass: 'unknown' });

    await handleGoalFailed('goal-1');

    // Should call classifyFailureAction as fallback
    expect(mockClassifyFailureAction).toHaveBeenCalledWith('some error');
  });

  test('B.1: persists failureType on GoalExecution if not already set', async () => {
    mockGoalExecFindFirst.mockResolvedValue({
      id: 'exec-1', error: 'worktree lost', stepIndex: 0, failureType: null,
    });
    mockClassifyFailureAction.mockReturnValue({ action: 'retry-execution', failureClass: 'infrastructure' });

    await handleGoalFailed('goal-1');

    // Should update the execution with failureType
    expect(mockExecUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({ failureType: 'infrastructure' }),
      })
    );
  });
});
