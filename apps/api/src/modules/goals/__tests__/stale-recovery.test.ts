// AC-5: Stale Recovery tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFindMany, mockExecUpdate } = vi.hoisted(() => ({
  mockExecFindMany: vi.fn().mockResolvedValue([]),
  mockExecUpdate: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      findMany: mockExecFindMany,
      update: mockExecUpdate,
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('../goal.service', () => ({
  goalService: {
    updateStepExecution: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../execution-alarm', () => ({
  onPhaseFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  };
});

import { recoverStaleExecutions, recoverStaleWorkUnits, recoverOrphanedExecutions } from '../stale-recovery';

describe('Stale Recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recoverStaleExecutions releases timed-out executions', async () => {
    mockExecFindMany.mockResolvedValueOnce([
      {
        id: 'exec-1',
        goalId: 'goal-1',
        stepIndex: 0,
        startedAt: new Date(Date.now() - 30 * 60_000),
        timeoutAt: new Date(Date.now() - 10 * 60_000),
        input: null,
      },
    ]);

    const { onPhaseFailure } = await import('../execution-alarm');
    const count = await recoverStaleExecutions();

    expect(count).toBe(1);
    expect(onPhaseFailure).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'exec-1' }),
    );
  });

  it('recoverStaleWorkUnits is aliased to recoverStaleExecutions', async () => {
    mockExecFindMany.mockResolvedValueOnce([
      { id: 'exec-1', goalId: 'goal-1', stepIndex: 0, startedAt: new Date(), timeoutAt: new Date(Date.now() - 1000), input: null },
      { id: 'exec-2', goalId: 'goal-1', stepIndex: 1, startedAt: new Date(), timeoutAt: new Date(Date.now() - 2000), input: null },
    ]);

    const count = await recoverStaleWorkUnits();
    expect(count).toBe(2);
  });

  it('recoverStaleExecutions is idempotent', async () => {
    mockExecFindMany.mockResolvedValueOnce([
      { id: 'exec-1', goalId: 'goal-1', stepIndex: 0, startedAt: new Date(), timeoutAt: new Date(Date.now() - 1000), input: null },
    ]);
    const count1 = await recoverStaleExecutions();

    mockExecFindMany.mockResolvedValueOnce([
      { id: 'exec-1', goalId: 'goal-1', stepIndex: 0, startedAt: new Date(), timeoutAt: new Date(Date.now() - 1000), input: null },
    ]);
    const count2 = await recoverStaleExecutions();

    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('recoverOrphanedExecutions handles missing worktree', async () => {
    mockExecFindMany.mockResolvedValueOnce([
      { id: 'exec-orphan', status: 'running', input: null },
    ]);

    const { goalService } = await import('../goal.service');
    const count = await recoverOrphanedExecutions();

    expect(count).toBe(1);
    expect(goalService.updateStepExecution).toHaveBeenCalledWith(
      'exec-orphan',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
