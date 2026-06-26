/**
 * Behavioral tests for failureType wiring in scheduler-dispatch
 *
 * AC:
 * - When execution fails, failureType is written to GoalExecution via updateStepExecution
 * - failureType matches classifyFailureAction().failureClass
 * - Both handleDispatchFailure path and catch block path write failureType
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockUpdateStepExecution,
  mockAgentExecute,
  mockWuUpdate,
  mockWuTransitionStatus,
  mockGetById,
  mockPrismaCreate,
  mockPrismaFindMany,
} = vi.hoisted(() => ({
  mockUpdateStepExecution: vi.fn().mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' }),
  mockAgentExecute: vi.fn(),
  mockWuUpdate: vi.fn().mockResolvedValue({}),
  mockWuTransitionStatus: vi.fn().mockResolvedValue({}),
  mockGetById: vi.fn().mockResolvedValue({ retryCount: 3 }),
  mockPrismaCreate: vi.fn().mockResolvedValue({}),
  mockPrismaFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    update: mockWuUpdate,
    transitionStatus: mockWuTransitionStatus,
    getById: mockGetById,
  })),
}));

// Mock prisma
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: {
      create: mockPrismaCreate,
      findMany: mockPrismaFindMany,
    },
    project: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    failureEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getModelForTier: vi.fn().mockReturnValue({ model: 'claude-sonnet-4-20250514' }),
  };
});

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { execute: mockAgentExecute },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeAgentDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../goal.service.js', () => ({
  goalService: {
    updateStepExecution: mockUpdateStepExecution,
    checkGoalCompletion: vi.fn().mockResolvedValue(undefined),
  },
  parseJsonField: <T>(val: unknown, def: T): T => {
    if (val === null || val === undefined) return def;
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return def; } }
    return val as T;
  },
}));

vi.mock('../scheduler-prompt.js', () => ({
  buildSubAgentPrompt: vi.fn().mockReturnValue('mock-prompt'),
  buildLegacyPrompt: vi.fn().mockReturnValue('mock-prompt'),
  buildIntegrationPrompt: vi.fn().mockResolvedValue('mock-prompt'),
  getSiblingContext: vi.fn().mockResolvedValue(''),
  getCompanyKnowledge: vi.fn().mockResolvedValue(''),
  getProjectRepoPath: vi.fn().mockResolvedValue('/tmp/repo'),
  findTaskBranch: vi.fn().mockResolvedValue(null),
  runIntegrationInCode: vi.fn(),
}));

vi.mock('../roles/role-config.service.js', () => ({
  roleConfigService: { getOrCreate: vi.fn().mockResolvedValue({ boundConstraints: '[]', boundSkills: [] }) },
}));

vi.mock('../knowledge/preference-observer.js', () => ({
  preferenceObserver: { updateFromRoutingFeedback: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../events/session-summary-generator.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/git.js', () => ({
  getDefaultBranch: vi.fn().mockReturnValue('main'),
}));

vi.mock('../../daemon/metrics.js', () => ({
  recordExecution: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchStep, type DispatchContext } from '../scheduler-dispatch.js';

function makeCtx(): DispatchContext {
  return {
    runtimeConstraints: new Map(),
    recentFailures: 0,
    recentTotal: 0,
  };
}

function makeExec() {
  return {
    id: 'exec-1',
    goalId: 'goal-1',
    stepIndex: 0,
    status: 'pending',
    input: JSON.stringify({ acGroup: { acs: ['test ac'], files: ['test.ts'] } }),
  };
}

function makeGoal() {
  return {
    id: 'goal-1',
    scope: 'Test goal',
    status: 'running',
    title: 'Test goal',
    context: JSON.stringify({ sourceChannelId: 'ch-1' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('failureType wiring in dispatchStep', () => {
  test('writes failureType=retryable when agent fails with exit code error', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'exit code 1',
      sessionIds: [],
    });

    mockGetById.mockResolvedValue({ retryCount: 3 });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const failureCalls = mockWuUpdate.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => call[1]?.failureType !== undefined
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    expect(failureCalls[failureCalls.length - 1][1].failureType).toBe('retryable');
  });

  test('writes failureType=not-retryable when agent fails with approach infeasible', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'The approach is infeasible because API does not exist',
      sessionIds: [],
    });
    mockGetById.mockResolvedValue({ retryCount: 3 });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const failureCalls = mockWuUpdate.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => call[1]?.failureType !== undefined
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    expect(failureCalls[failureCalls.length - 1][1].failureType).toBe('not-retryable');
  });

  test('writes failureType=infrastructure when agent fails with worktree error', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'worktree directory ENOENT: /root/worktrees/abc123',
      sessionIds: [],
    });
    mockGetById.mockResolvedValue({ retryCount: 3 });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const failureCalls = mockWuUpdate.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => call[1]?.failureType !== undefined
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    expect(failureCalls[failureCalls.length - 1][1].failureType).toBe('infrastructure');
  });

  test('writes failureType=unknown when agent fails with unrecognized error', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'Something weird happened',
      sessionIds: [],
    });
    mockGetById.mockResolvedValue({ retryCount: 3 });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const failureCalls = mockWuUpdate.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => call[1]?.failureType !== undefined
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    expect(failureCalls[failureCalls.length - 1][1].failureType).toBe('unknown');
  });

  test('writes failureType in catch block when agent throws', async () => {
    mockAgentExecute.mockRejectedValue(new Error('TypeError: Cannot read properties of undefined'));

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const failureCalls = mockWuUpdate.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => call[1]?.failureType !== undefined
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    expect(failureCalls[failureCalls.length - 1][1].failureType).toBe('retryable');
  });
});
