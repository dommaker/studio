/**
 * Behavioral tests for P5: AC granularity quality gate
 *
 * AC:
 * - createGoalFromChannelDoc rejects when acGroup.files.length > 5
 * - createGoalFromChannelDoc accepts when files.length <= 5
 * - Error message includes group id and file count
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockGoalCount,
  mockGoalCreate,
  mockGoalExecCreate,
} = vi.hoisted(() => ({
  mockGoalCount: vi.fn().mockResolvedValue(0),
  mockGoalCreate: vi.fn().mockResolvedValue({ id: 'goal-1' }),
  mockGoalExecCreate: vi.fn().mockResolvedValue({}),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goal: { count: mockGoalCount, create: mockGoalCreate },
    goalExecution: { create: mockGoalExecCreate },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  eventBus: { publish: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeGoalCreate: vi.fn().mockResolvedValue(undefined),
}));

import { createGoalFromChannelDoc } from '../goal-crud.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGoalCount.mockResolvedValue(0);
  mockGoalCreate.mockResolvedValue({ id: 'goal-1' });
  mockGoalExecCreate.mockResolvedValue({});
});

function makeAcGroup(overrides?: { files?: string[] }) {
  return {
    id: 'test-group',
    acs: ['AC1'],
    files: overrides?.files || ['file1.ts'],
    dependencies: [],
  };
}

const baseInput = {
  title: 'Test goal',
  summary: 'Test summary',
  companyId: 'company-1',
  sourceChannelId: 'channel-1',
  requirementsDocId: 'reqdoc-1',
};

describe('P5: AC granularity quality gate', () => {
  test('rejects when acGroup.files.length > 5', async () => {
    const input = {
      ...baseInput,
      acGroups: [makeAcGroup({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] })],
    };

    await expect(createGoalFromChannelDoc(input)).rejects.toThrow(/6 个文件/);
    await expect(createGoalFromChannelDoc(input)).rejects.toThrow(/上限 5/);
  });

  test('error message includes group id', async () => {
    const input = {
      ...baseInput,
      acGroups: [{
        id: 'my-group',
        acs: ['AC1'],
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        dependencies: [],
      }],
    };

    await expect(createGoalFromChannelDoc(input)).rejects.toThrow(/my-group/);
  });

  test('accepts when files.length = 5 (at boundary)', async () => {
    const input = {
      ...baseInput,
      acGroups: [makeAcGroup({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] })],
    };

    await expect(createGoalFromChannelDoc(input)).resolves.toBeDefined();
    expect(mockGoalCreate).toHaveBeenCalled();
  });

  test('accepts when files.length = 1 (minimal)', async () => {
    const input = {
      ...baseInput,
      acGroups: [makeAcGroup({ files: ['only.ts'] })],
    };

    await expect(createGoalFromChannelDoc(input)).resolves.toBeDefined();
  });

  test('accepts when files is empty array', async () => {
    const input = {
      ...baseInput,
      acGroups: [makeAcGroup({ files: [] })],
    };

    await expect(createGoalFromChannelDoc(input)).resolves.toBeDefined();
  });

  test('checks all acGroups — second group exceeds limit', async () => {
    const input = {
      ...baseInput,
      acGroups: [
        makeAcGroup({ files: ['a.ts'] }),
        { id: 'big-group', acs: ['AC2'], files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], dependencies: [] },
      ],
    };

    await expect(createGoalFromChannelDoc(input)).rejects.toThrow(/big-group/);
  });
});
