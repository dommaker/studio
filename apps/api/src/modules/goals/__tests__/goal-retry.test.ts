/**
 * Behavioral tests for execution retry mechanism
 *
 * AC:
 * - Execution fails + retryCount < 3 → reset to 'pending', increment retryCount
 * - Execution fails + retryCount >= 3 → return false (exhausted)
 * - Retry preserves error info for context injection
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExecFindUnique, mockExecUpdate } = vi.hoisted(() => ({
  mockExecFindUnique: vi.fn(),
  mockExecUpdate: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      findUnique: mockExecFindUnique,
      update: mockExecUpdate,
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
  mockExecUpdate.mockResolvedValue({});
});

describe('maybeRetryExecution()', () => {
  test('retries when retryCount=0 (first failure)', async () => {
    mockExecFindUnique.mockResolvedValue({ retryCount: 0 });

    const result = await maybeRetryExecution('exec-1', 'agent crashed');

    expect(result).toBe(true);
    expect(mockExecUpdate).toHaveBeenCalledWith({
      where: { id: 'exec-1' },
      data: {
        status: 'pending',
        retryCount: 1,
        error: expect.stringContaining('agent crashed'),
        startedAt: null,
        completedAt: null,
      },
    });
    const errorPayload = JSON.parse(mockExecUpdate.mock.calls[0][0].data.error);
    expect(errorPayload.message).toBe('agent crashed');
    expect(errorPayload.retryAttempt).toBe(1);
  });

  test('retries when retryCount=2 (under limit)', async () => {
    mockExecFindUnique.mockResolvedValue({ retryCount: 2 });

    const result = await maybeRetryExecution('exec-1', 'timeout');

    expect(result).toBe(true);
    expect(mockExecUpdate.mock.calls[0][0].data.retryCount).toBe(3);
  });

  test('does not retry when retryCount=3 (at limit)', async () => {
    mockExecFindUnique.mockResolvedValue({ retryCount: 3 });

    const result = await maybeRetryExecution('exec-1', 'persistent error');

    expect(result).toBe(false);
    expect(mockExecUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when retryCount > 3', async () => {
    mockExecFindUnique.mockResolvedValue({ retryCount: 5 });

    const result = await maybeRetryExecution('exec-1', 'still failing');

    expect(result).toBe(false);
    expect(mockExecUpdate).not.toHaveBeenCalled();
  });

  test('returns false when execution not found', async () => {
    mockExecFindUnique.mockResolvedValue(null);

    const result = await maybeRetryExecution('exec-ghost', 'error');

    expect(result).toBe(false);
    expect(mockExecUpdate).not.toHaveBeenCalled();
  });

  test('respects custom maxRetries', async () => {
    mockExecFindUnique.mockResolvedValue({ retryCount: 1 });

    const result = await maybeRetryExecution('exec-1', 'error', 1);

    expect(result).toBe(false);
    expect(mockExecUpdate).not.toHaveBeenCalled();
  });

  test('retry resets startedAt and completedAt', async () => {
    mockExecFindUnique.mockResolvedValue({ retryCount: 0 });

    await maybeRetryExecution('exec-1', 'crash');

    const updateData = mockExecUpdate.mock.calls[0][0].data;
    expect(updateData.startedAt).toBeNull();
    expect(updateData.completedAt).toBeNull();
  });
});
