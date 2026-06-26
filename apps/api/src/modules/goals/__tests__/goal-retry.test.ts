/**
 * Behavioral tests for execution retry mechanism
 *
 * AC:
 * - Execution fails + retryCount < 3 → reset to 'pending', increment retryCount
 * - Execution fails + retryCount >= 3 → return false (exhausted)
 * - Retry preserves error info for context injection
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

vi.mock('../failure-classifier.js', () => ({
  classifyFailure: vi.fn().mockReturnValue('retryable'),
  classifyFailureAction: vi.fn().mockReturnValue({ action: 'retry', failureClass: 'retryable' }),
}));

import { maybeRetryExecution } from '../scheduler-dispatch.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({});
});

describe('maybeRetryExecution()', () => {
  test('retries when retryCount=0 (first failure)', async () => {
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 0, input: null });

    const result = await maybeRetryExecution('exec-1', 'agent crashed');

    expect(result).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({
          retryCount: 1,
          completedAt: null,
        }),
      })
    );
  });

  test('retries when retryCount=2 (under limit)', async () => {
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 2, input: null });

    const result = await maybeRetryExecution('exec-1', 'timeout');

    expect(result).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({ retryCount: 3 }),
      })
    );
  });

  test('does not retry when retryCount=3 (at limit)', async () => {
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 3, input: null });

    const result = await maybeRetryExecution('exec-1', 'persistent error');

    expect(result).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when retryCount > 3', async () => {
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 5, input: null });

    const result = await maybeRetryExecution('exec-1', 'still failing');

    expect(result).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('returns false when execution not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await maybeRetryExecution('exec-ghost', 'error');

    expect(result).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('respects custom maxRetries', async () => {
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 1, input: null });

    const result = await maybeRetryExecution('exec-1', 'error', 1);

    expect(result).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when failure is not-retryable (approach infeasible)', async () => {
    const { classifyFailure } = await import('../failure-classifier.js');
    vi.mocked(classifyFailure).mockReturnValueOnce('not-retryable');
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 0, input: null });

    const result = await maybeRetryExecution('exec-1', 'The approach is infeasible');

    expect(result).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('does not retry when failure is not-retryable (API does not exist)', async () => {
    const { classifyFailure } = await import('../failure-classifier.js');
    vi.mocked(classifyFailure).mockReturnValueOnce('not-retryable');
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 0, input: null });

    const result = await maybeRetryExecution('exec-1', 'Error: API endpoint does not exist');

    expect(result).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('retries when failure is unknown (allows retry for diagnosis)', async () => {
    const { classifyFailure } = await import('../failure-classifier.js');
    vi.mocked(classifyFailure).mockReturnValueOnce('unknown');
    mockFindUnique.mockResolvedValue({ id: 'exec-1', retryCount: 0, input: null });

    const result = await maybeRetryExecution('exec-1', 'Something weird happened');

    expect(result).toBe(true);
  });
});
