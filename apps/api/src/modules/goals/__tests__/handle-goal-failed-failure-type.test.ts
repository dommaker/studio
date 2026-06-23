/**
 * handleGoalFailed failureType routing tests
 *
 * AC B.2: handleGoalFailed reads failureType from WorkUnit, uses it for routing
 * AC B.3: select includes failureType
 * AC B.4: handleGoalFailed routes correctly based on failureType
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockWuFindUnique,
  mockWuFindMany,
  mockWuUpdate,
  mockFailureEventFindFirst,
  mockHandleAlert,
  mockClassifyFailureAction,
} = vi.hoisted(() => ({
  mockWuFindUnique: vi.fn(),
  mockWuFindMany: vi.fn(),
  mockWuUpdate: vi.fn(),
  mockFailureEventFindFirst: vi.fn(),
  mockHandleAlert: vi.fn(),
  mockClassifyFailureAction: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: {
      findUnique: mockWuFindUnique,
      findMany: mockWuFindMany,
      update: mockWuUpdate,
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
  // Goal WorkUnit (parent)
  mockWuFindUnique.mockResolvedValue({
    id: 'goal-1',
    scope: 'Test Goal',
    status: 'active',
    metadata: JSON.stringify({ title: 'Test Goal', context: '{}' }),
  });
  mockWuFindMany.mockResolvedValue([]);
  mockFailureEventFindFirst.mockResolvedValue(null);
  mockClassifyFailureAction.mockReturnValue({ action: 'triage-agent', failureClass: 'unknown' });
  mockHandleAlert.mockResolvedValue(undefined);
  mockWuUpdate.mockResolvedValue({});
});

import { handleGoalFailed } from '../goal-lifecycle.js';

describe('handleGoalFailed — failureType routing (B.2/B.3/B.4)', () => {
  test('B.3: reads failureType from closed WorkUnit', async () => {
    mockWuFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'closed',
      failureType: 'retryable',
      parentId: 'goal-1',
      metadata: JSON.stringify({ goalId: 'goal-1', error: 'exit code 1', stepIndex: 0 }),
      updatedAt: new Date(),
    }]);

    await handleGoalFailed('goal-1');

    // Verify workUnit.findMany was called to get child work units
    expect(mockWuFindMany).toHaveBeenCalled();
  });

  test('B.2: uses failureType=infrastructure for retry instead of classifyFailureAction', async () => {
    mockWuFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'closed',
      failureType: 'infrastructure',
      parentId: 'goal-1',
      metadata: JSON.stringify({ goalId: 'goal-1', error: 'worktree lost', stepIndex: 0 }),
      updatedAt: new Date(),
    }]);
    // retryGoalExecution needs findUnique to return the execution
    mockWuFindUnique
      .mockResolvedValueOnce({ id: 'goal-1', scope: 'Test Goal', status: 'active', metadata: JSON.stringify({ title: 'Test Goal', context: '{}' }) })
      .mockResolvedValueOnce({ id: 'exec-1', status: 'closed', retryCount: 0, metadata: JSON.stringify({ goalId: 'goal-1', error: 'worktree lost' }) });

    await handleGoalFailed('goal-1');

    // Should NOT call classifyFailureAction when failureType is present
    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    // retryGoalExecution transitions to 'active' via workUnit.update
    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active' }),
      })
    );
  });

  test('B.2: uses failureType=retryable for retry', async () => {
    mockWuFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'closed',
      failureType: 'retryable',
      parentId: 'goal-1',
      metadata: JSON.stringify({ goalId: 'goal-1', error: 'TypeError: undefined', stepIndex: 0 }),
      updatedAt: new Date(),
    }]);
    mockWuFindUnique
      .mockResolvedValueOnce({ id: 'goal-1', scope: 'Test Goal', status: 'active', metadata: JSON.stringify({ title: 'Test Goal', context: '{}' }) })
      .mockResolvedValueOnce({ id: 'exec-1', status: 'closed', retryCount: 0, metadata: JSON.stringify({ goalId: 'goal-1', error: 'TypeError: undefined' }) });

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active' }),
      })
    );
  });

  test('B.2: uses failureType=not-retryable for mark-blocked (no retry, no triage)', async () => {
    mockWuFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'closed',
      failureType: 'not-retryable',
      parentId: 'goal-1',
      metadata: JSON.stringify({ goalId: 'goal-1', error: 'approach infeasible', stepIndex: 0 }),
      updatedAt: new Date(),
    }]);

    await handleGoalFailed('goal-1');

    expect(mockClassifyFailureAction).not.toHaveBeenCalled();
    // not-retryable → mark-blocked: no retry (no update to 'active'), no triage
    const activeUpdates = mockWuUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'active'
    );
    expect(activeUpdates.length).toBe(0);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });

  test('B.2: fallback to classifyFailureAction when failureType is null', async () => {
    mockWuFindMany.mockResolvedValue([{
      id: 'exec-1',
      status: 'closed',
      failureType: null,
      parentId: 'goal-1',
      metadata: JSON.stringify({ goalId: 'goal-1', error: 'some error', stepIndex: 0 }),
      updatedAt: new Date(),
    }]);
    mockClassifyFailureAction.mockReturnValue({ action: 'triage-agent', failureClass: 'unknown' });

    await handleGoalFailed('goal-1');

    // Should call classifyFailureAction as fallback
    expect(mockClassifyFailureAction).toHaveBeenCalledWith('some error');
  });
});
