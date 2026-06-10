/**
 * Behavioral tests for checkGoalCompletion()
 *
 * AC: step failed 且后续 step 依赖阻塞 → goal 标记 failed（不永远卡住）
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockFindMany, mockUpdate, mockCreate, mockFindFirst, mockGoalUpdate, mockGoalFindUnique, mockGoalExecFindFirst } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockCreate: vi.fn(),
  mockFindFirst: vi.fn(),
  mockGoalUpdate: vi.fn(),
  mockGoalFindUnique: vi.fn(),
  mockGoalExecFindFirst: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      findMany: mockFindMany,
      update: mockUpdate,
      create: mockCreate,
      findFirst: mockGoalExecFindFirst,
    },
    goalPlan: {
      findFirst: mockFindFirst,
    },
    goal: {
      update: mockGoalUpdate,
      findUnique: mockGoalFindUnique,
    },
    failureEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

vi.mock('../goal-review.js', () => ({
  handleGoalSucceeded: vi.fn(),
  findReviewWorktree: vi.fn(),
}));

import { checkGoalCompletion } from '../goal-lifecycle.js';

function makeExec(stepIndex: number, status: string, overrides?: Record<string, any>) {
  return {
    id: `exec-${stepIndex}`,
    stepIndex,
    status,
    goalId: 'goal-1',
    input: JSON.stringify({ acGroup: { id: `step-${stepIndex}` } }),
    ...overrides,
  };
}

function makePlan(steps: Array<{ index: number; dependencies: number[] }>) {
  return {
    id: 'plan-1',
    goalId: 'goal-1',
    status: 'approved',
    steps: JSON.stringify(steps.map(s => ({
      index: s.index,
      title: `step-${s.index}`,
      description: '',
      agentType: 'claude',
      input: {},
      dependencies: s.dependencies,
      estimatedDuration: '30m',
    }))),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGoalUpdate.mockResolvedValue({});
  mockUpdate.mockResolvedValue({});
  mockCreate.mockResolvedValue({});
  mockGoalFindUnique.mockResolvedValue({ id: 'goal-1', context: {} });
  mockGoalExecFindFirst.mockResolvedValue(null);
});

describe('checkGoalCompletion()', () => {
  test('marks goal failed when step 0 failed and steps 1-4 blocked by dependency', async () => {
    const executions = [
      makeExec(0, 'failed'),
      makeExec(1, 'pending'),
      makeExec(2, 'pending'),
      makeExec(3, 'pending'),
      makeExec(4, 'pending'),
    ];
    mockFindMany.mockResolvedValue(executions);
    mockFindFirst.mockResolvedValue(makePlan([
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [0] },
      { index: 3, dependencies: [0] },
      { index: 4, dependencies: [0] },
    ]));

    await checkGoalCompletion('goal-1');

    // Blocked steps should be marked as failed
    const blockedUpdates = mockUpdate.mock.calls.filter(
      (c: any) => c[0]?.where?.id?.startsWith('exec-') && c[0]?.data?.status === 'failed'
    );
    expect(blockedUpdates.length).toBe(4); // steps 1-4

    // Goal should be marked as failed
    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });

  test('does not cascade when no dependencies exist (flat plan)', async () => {
    const executions = [
      makeExec(0, 'failed'),
      makeExec(1, 'pending'),
    ];
    mockFindMany.mockResolvedValue(executions);
    mockFindFirst.mockResolvedValue(makePlan([
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [] }, // no dependency on step 0
    ]));

    await checkGoalCompletion('goal-1');

    // Step 1 should NOT be cascaded (no dependency)
    expect(mockUpdate).not.toHaveBeenCalled();
    // Goal should NOT be marked (step 1 still pending)
    expect(mockGoalUpdate).not.toHaveBeenCalled();
  });

  test('does not cascade when dependency succeeded', async () => {
    const executions = [
      makeExec(0, 'succeeded'),
      makeExec(1, 'pending'),
    ];
    mockFindMany.mockResolvedValue(executions);
    mockFindFirst.mockResolvedValue(makePlan([
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
    ]));

    await checkGoalCompletion('goal-1');

    // Step 1 should NOT be cascaded (dependency succeeded)
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('marks goal succeeded when single step succeeded', async () => {
    // Single step: skips integration step logic (regularSteps.length > 1)
    const executions = [makeExec(0, 'succeeded')];
    mockFindMany.mockResolvedValue(executions);
    mockFindFirst.mockResolvedValue(makePlan([
      { index: 0, dependencies: [] },
    ]));

    await checkGoalCompletion('goal-1');

    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'succeeded', completedAt: expect.any(Date) },
    });
  });

  test('handles chain dependency: step 0 failed → step 1 blocked → step 2 blocked', async () => {
    const executions = [
      makeExec(0, 'failed'),
      makeExec(1, 'pending'),
      makeExec(2, 'pending'),
    ];
    mockFindMany.mockResolvedValue(executions);
    mockFindFirst.mockResolvedValue(makePlan([
      { index: 0, dependencies: [] },
      { index: 1, dependencies: [0] },
      { index: 2, dependencies: [1] }, // depends on step 1, not step 0 directly
    ]));

    await checkGoalCompletion('goal-1');

    // Both step 1 and step 2 should be cascaded
    const blockedUpdates = mockUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'failed'
    );
    expect(blockedUpdates.length).toBe(2); // steps 1 and 2

    expect(mockGoalUpdate).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });
});
