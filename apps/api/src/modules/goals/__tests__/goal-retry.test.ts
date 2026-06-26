/**
 * Behavioral tests for execution retry mechanism
 *
 * AC:
 * - Execution fails + retryCount < 3 → reset to 'pending', increment retryCount
 * - Execution fails + retryCount >= 3 → return false (exhausted)
 * - Retry preserves error info for context injection
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetById, mockWuUpdate, mockWuTransitionStatus } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockWuUpdate: vi.fn().mockResolvedValue({}),
  mockWuTransitionStatus: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    getById: mockGetById,
    update: mockWuUpdate,
    transitionStatus: mockWuTransitionStatus,
  })),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

import { maybeRetryExecution } from '../scheduler-dispatch.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockWuUpdate.mockResolvedValue({});
  mockWuTransitionStatus.mockResolvedValue({});
});

describe('maybeRetryExecution()', () => {
  test('retries when retryCount=0 (first failure)', async () => {
    mockGetById.mockResolvedValue({ retryCount: 0 });

    const result = await maybeRetryExecution('exec-1', 'agent crashed');

    expect(result).toBe(true);
    expect(mockWuUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        retryCount: 1,
        completedAt: null,
      })
    );
    expect(mockWuTransitionStatus).toHaveBeenCalledWith('exec-1', 'pending');
  });

  test('retries when retryCount=2 (under limit)', async () => {
    mockGetById.mockResolvedValue({ retryCount: 2 });

    const result = await maybeRetryExecution('exec-1', 'timeout');

    expect(result).toBe(true);
    expect(mockWuUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ retryCount: 3 })
    );
  });

  test('does not retry when retryCount=3 (at limit)', async () => {
    mockGetById.mockResolvedValue({ retryCount: 3 });

    const result = await maybeRetryExecution('exec-1', 'persistent error');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when retryCount > 3', async () => {
    mockGetById.mockResolvedValue({ retryCount: 5 });

    const result = await maybeRetryExecution('exec-1', 'still failing');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('returns false when execution not found', async () => {
    mockGetById.mockResolvedValue(null);

    const result = await maybeRetryExecution('exec-ghost', 'error');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('respects custom maxRetries', async () => {
    mockGetById.mockResolvedValue({ retryCount: 1 });

    const result = await maybeRetryExecution('exec-1', 'error', 1);

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when failure is not-retryable (approach infeasible)', async () => {
    mockGetById.mockResolvedValue({ retryCount: 0 });

    const result = await maybeRetryExecution('exec-1', 'The approach is infeasible');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when failure is not-retryable (API does not exist)', async () => {
    mockGetById.mockResolvedValue({ retryCount: 0 });

    const result = await maybeRetryExecution('exec-1', 'Error: API endpoint does not exist');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('retries when failure is unknown (allows retry for diagnosis)', async () => {
    mockGetById.mockResolvedValue({ retryCount: 0 });

    const result = await maybeRetryExecution('exec-1', 'Something weird happened');

    expect(result).toBe(true);
  });
});
