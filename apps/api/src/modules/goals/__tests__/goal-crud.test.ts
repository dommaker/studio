/**
 * Goal CRUD contract tests
 *
 * AC C.4: Verify listGoals with/without failureType filter
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goal: { findMany: mockFindMany },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  modelGateway: {},
  eventBus: { publish: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeGoalCreate: vi.fn(),
}));

import { listGoals } from '../goal-crud.js';

describe('listGoals', () => {
  beforeEach(() => {
    mockFindMany.mockClear();
    mockFindMany.mockResolvedValue([]);
  });

  it('calls prisma without failureType filter when not provided', async () => {
    await listGoals('company-1');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { companyId: 'company-1' },
      include: { GoalPlan: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('adds GoalExecution relation filter when failureType provided', async () => {
    await listGoals('company-1', undefined, 'not-retryable');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        companyId: 'company-1',
        GoalExecution: { some: { failureType: 'not-retryable' } },
      },
      include: { GoalPlan: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('combines status and failureType filters', async () => {
    await listGoals('company-1', 'failed', 'not-retryable');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        companyId: 'company-1',
        status: 'failed',
        GoalExecution: { some: { failureType: 'not-retryable' } },
      },
      include: { GoalPlan: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns empty array when no goals match', async () => {
    const result = await listGoals('company-1', undefined, 'nonexistent');
    expect(result).toEqual([]);
  });
});
