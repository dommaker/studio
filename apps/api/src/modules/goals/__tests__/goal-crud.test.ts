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

  it('calls prisma without status filter when not provided', async () => {
    await listGoals('company-1');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { companyId: 'company-1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('applies status filter when provided', async () => {
    await listGoals('company-1', 'failed');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        companyId: 'company-1',
        status: 'failed',
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns empty array when no goals match', async () => {
    const result = await listGoals('company-1');
    expect(result).toEqual([]);
  });
});
