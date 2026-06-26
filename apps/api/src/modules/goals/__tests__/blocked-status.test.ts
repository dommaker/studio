/**
 * Behavioral tests for blocked_by_dependency status in handleDispatchFailure
 *
 * AC:
 * - not-retryable error → status 'blocked_by_dependency' written
 * - retryable error (after retries exhausted) → status 'failed' written
 * - infrastructure error (after retries exhausted) → status 'failed' written
 * - unknown error → status 'failed' written (triage-agent action)
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

/** Get the last workUnitService.update call's data payload that contains a failureType */
function lastFailurePayload(): Record<string, unknown> {
  const failureCalls = mockWuUpdate.mock.calls.filter(
    (call: [string, Record<string, unknown>]) => call[1]?.failureType !== undefined
  );
  expect(failureCalls.length).toBeGreaterThanOrEqual(1);
  return failureCalls[failureCalls.length - 1][1];
}

/** Get the last workUnitService.transitionStatus call's status value */
function lastStatusTransition(): string {
  const statusCalls = mockWuTransitionStatus.mock.calls;
  expect(statusCalls.length).toBeGreaterThanOrEqual(1);
  return statusCalls[statusCalls.length - 1][1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  // retries exhausted so maybeRetryExecution returns false
  mockGetById.mockResolvedValue({ retryCount: 3 });
});

describe('handleDispatchFailure status routing', () => {
  test('not-retryable → status blocked', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'The approach is infeasible because API does not exist',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('not-retryable');
    expect(lastStatusTransition()).toBe('blocked');
  });

  test('retryable (retries exhausted) → status closed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'exit code 1',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('retryable');
    expect(lastStatusTransition()).toBe('closed');
  });

  test('infrastructure (retries exhausted) → status closed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'worktree directory ENOENT: /root/worktrees/abc123',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('infrastructure');
    expect(lastStatusTransition()).toBe('closed');
  });

  test('unknown (triage-agent action) → status closed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'Something weird happened',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('unknown');
    expect(lastStatusTransition()).toBe('closed');
  });
});
