/**
 * listGoals failureType filter pass-through tests
 *
 * AC C.2: routes.ts extracts failureType from query and passes to listGoals
 * AC C.3: goal.service.ts listGoals accepts failureType (forwarded but not yet used in query)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goal: { findMany: mockFindMany },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
});

describe('GoalService.listGoals — failureType pass-through (C.3)', () => {
  test('passes failureType to goal-crud listGoals (currently no-op)', async () => {
    const { GoalService } = await import('../goal.service.js');
    const service = new GoalService();

    await service.listGoals('company-1', undefined, 'not-retryable');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'company-1',
        }),
      })
    );
  });

  test('passes both status and failureType', async () => {
    const { GoalService } = await import('../goal.service.js');
    const service = new GoalService();

    await service.listGoals('company-1', 'failed', 'infrastructure');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'company-1',
          status: 'failed',
        }),
      })
    );
  });

  test('works without failureType (backward compatible)', async () => {
    const { GoalService } = await import('../goal.service.js');
    const service = new GoalService();

    await service.listGoals('company-1');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'company-1' },
      })
    );
  });
});
