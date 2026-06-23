/**
 * Behavioral tests for execution retry mechanism
 *
 * AC:
 * - Execution fails + retryCount < 3 → reset to 'unassigned', increment retryCount
 * - Execution fails + retryCount >= 3 → return false (exhausted)
 * - Retry preserves error info for context injection
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockWuFindUnique, mockWuUpdate } = vi.hoisted(() => ({
  mockWuFindUnique: vi.fn(),
  mockWuUpdate: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: {
      findUnique: mockWuFindUnique,
      update: mockWuUpdate,
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

import { maybeRetryExecution } from '../scheduler-dispatch.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockWuUpdate.mockResolvedValue({});
});

describe('maybeRetryExecution()', () => {
  test('retries when retryCount=0 (first failure)', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 0, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'agent crashed');

    expect(result).toBe(true);
    // workUnitService.update called with retryCount + metadata
    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({
          retryCount: 1,
          metadata: expect.objectContaining({
            error: expect.stringContaining('agent crashed'),
          }),
        }),
      })
    );
    // transitionStatus also calls update with status: 'unassigned'
    const statusUpdate = mockWuUpdate.mock.calls.find(
      (c: any) => c[0]?.data?.status === 'unassigned'
    );
    expect(statusUpdate).toBeDefined();
  });

  test('retries when retryCount=2 (under limit)', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 2, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'timeout');

    expect(result).toBe(true);
    expect(mockWuUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ retryCount: 3 }),
      })
    );
  });

  test('does not retry when retryCount=3 (at limit)', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 3, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'persistent error');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when retryCount > 3', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 5, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'still failing');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('returns false when execution not found', async () => {
    mockWuFindUnique.mockResolvedValue(null);

    const result = await maybeRetryExecution('exec-ghost', 'error');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('respects custom maxRetries', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 1, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'error', 1);

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when failure is not-retryable (approach infeasible)', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 0, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'The approach is infeasible');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when failure is not-retryable (API does not exist)', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 0, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'Error: API endpoint does not exist');

    expect(result).toBe(false);
    expect(mockWuUpdate).not.toHaveBeenCalled();
  });

  test('retries when failure is unknown (allows retry for diagnosis)', async () => {
    mockWuFindUnique.mockResolvedValue({ retryCount: 0, metadata: null });

    const result = await maybeRetryExecution('exec-1', 'Something weird happened');

    expect(result).toBe(true);
  });
});
