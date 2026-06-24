// AC-5: Stale Recovery tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany, mockUpdateMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
  mockUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: {
      findMany: mockFindMany,
      updateMany: mockUpdateMany,
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

import { recoverStaleWorkUnits, recoverOrphanedExecutions } from '../stale-recovery';

describe('Stale Recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recoverStaleWorkUnits releases timed-out claims', async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'wu-1',
        parentId: null,
        claimedAt: new Date(Date.now() - 30 * 60_000),
        timeoutAt: new Date(Date.now() - 10 * 60_000),
        metadata: null,
      },
    ]);

    const { onPhaseFailure } = await import('../execution-alarm');
    const count = await recoverStaleWorkUnits();

    expect(count).toBe(1);
    expect(onPhaseFailure).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'wu-1' }),
    );
  });

  it('recoverStaleWorkUnits returns count of released', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'wu-1', parentId: null, claimedAt: new Date(), timeoutAt: new Date(Date.now() - 1000), metadata: null },
      { id: 'wu-2', parentId: null, claimedAt: new Date(), timeoutAt: new Date(Date.now() - 2000), metadata: null },
    ]);

    const count = await recoverStaleWorkUnits();
    expect(count).toBe(2);
  });

  it('recoverStaleWorkUnits is idempotent', async () => {
    // First call finds timed-out items
    mockFindMany.mockResolvedValueOnce([
      { id: 'wu-1', parentId: null, claimedAt: new Date(), timeoutAt: new Date(Date.now() - 1000), metadata: null },
    ]);
    const count1 = await recoverStaleWorkUnits();

    // Second call — same items would be found again (idempotent because onPhaseFailure handles it)
    mockFindMany.mockResolvedValueOnce([
      { id: 'wu-1', parentId: null, claimedAt: new Date(), timeoutAt: new Date(Date.now() - 1000), metadata: null },
    ]);
    const count2 = await recoverStaleWorkUnits();

    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('recoverOrphanedExecutions handles missing worktree', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'wu-orphan', status: 'active', metadata: null },
    ]);

    const { goalService } = await import('../goal.service');
    const count = await recoverOrphanedExecutions();

    expect(count).toBe(1);
    expect(goalService.updateStepExecution).toHaveBeenCalledWith(
      'wu-orphan',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
