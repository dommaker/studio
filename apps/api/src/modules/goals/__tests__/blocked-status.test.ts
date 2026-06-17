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
  mockPrismaUpdate,
  mockPrismaCreate,
  mockPrismaFindMany,
  mockPrismaFindUnique,
  mockPrismaFindFirst,
} = vi.hoisted(() => ({
  mockUpdateStepExecution: vi.fn().mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' }),
  mockAgentExecute: vi.fn(),
  mockPrismaUpdate: vi.fn().mockResolvedValue({}),
  mockPrismaCreate: vi.fn().mockResolvedValue({}),
  mockPrismaFindMany: vi.fn().mockResolvedValue([]),
  mockPrismaFindUnique: vi.fn().mockResolvedValue({ retryCount: 3 }),
  mockPrismaFindFirst: vi.fn().mockResolvedValue(null),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      update: mockPrismaUpdate,
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: mockPrismaFindFirst,
      findUnique: mockPrismaFindUnique,
    },
    studioEvent: {
      create: mockPrismaCreate,
      findMany: mockPrismaFindMany,
    },
    project: {
      findUnique: mockPrismaFindUnique,
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
  recordPipelineRun: vi.fn().mockResolvedValue(undefined),
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
    title: 'Test goal',
    status: 'in_progress',
    context: JSON.stringify({ sourceChannelId: 'ch-1' }),
  };
}

/** Get the last updateStepExecution call's data payload */
function lastFailurePayload(): Record<string, unknown> {
  const failureCalls = mockUpdateStepExecution.mock.calls.filter(
    (call: [string, Record<string, unknown>]) =>
      call[1]?.status === 'failed' || call[1]?.status === 'blocked_by_dependency'
  );
  expect(failureCalls.length).toBeGreaterThanOrEqual(1);
  return failureCalls[failureCalls.length - 1][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  // retries exhausted so maybeRetryExecution returns false
  mockPrismaFindUnique.mockResolvedValue({ retryCount: 3 });
});

describe('handleDispatchFailure status routing', () => {
  test('not-retryable → status blocked_by_dependency', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'The approach is infeasible because API does not exist',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.status).toBe('blocked_by_dependency');
    expect(payload.failureType).toBe('not-retryable');
  });

  test('retryable (retries exhausted) → status failed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'exit code 1',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.status).toBe('failed');
    expect(payload.failureType).toBe('retryable');
  });

  test('infrastructure (retries exhausted) → status failed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'worktree directory ENOENT: /root/worktrees/abc123',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.status).toBe('failed');
    expect(payload.failureType).toBe('infrastructure');
  });

  test('unknown (triage-agent action) → status failed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'Something weird happened',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.status).toBe('failed');
    expect(payload.failureType).toBe('unknown');
  });
});
