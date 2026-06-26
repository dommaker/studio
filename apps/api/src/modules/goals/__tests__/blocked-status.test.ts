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
  mockGoalExecUpdate,
  mockGoalExecFindUnique,
  mockAgentExecute,
  mockPrismaCreate,
  mockPrismaFindMany,
} = vi.hoisted(() => ({
  mockGoalExecUpdate: vi.fn().mockResolvedValue({}),
  mockGoalExecFindUnique: vi.fn().mockResolvedValue({ retryCount: 3 }),
  mockAgentExecute: vi.fn(),
  mockPrismaCreate: vi.fn().mockResolvedValue({}),
  mockPrismaFindMany: vi.fn().mockResolvedValue([]),
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
    pipelineDecision: {
      create: vi.fn().mockResolvedValue({}),
    },
    failureEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    goalExecution: {
      update: mockGoalExecUpdate,
      findUnique: mockGoalExecFindUnique,
      findMany: vi.fn().mockResolvedValue([]),
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
    updateStepExecution: vi.fn().mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'failed' }),
    checkGoalCompletion: vi.fn().mockResolvedValue(undefined),
  },
  parseJsonField: <T>(val: unknown, def: T): T => {
    if (val === null || val === undefined) return def;
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return def; } }
    return val as T;
  },
}));



vi.mock('../execution-alarm.js', () => ({
  onPhaseFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../integration-rollback.js', () => ({
  rollbackToIntegrationStep: vi.fn(),
  parseIntegrationFailureType: vi.fn(),
}));

vi.mock('../scheduler-queue.js', () => ({
  getDispatchStrategy: vi.fn().mockReturnValue('normal'),
  updateDispatchOutcome: vi.fn().mockReturnValue({ failures: 0, total: 1 }),
  parseAgentTokenUsage: vi.fn().mockReturnValue({ model: 'fast', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 }),
}));

vi.mock('../knowledge/knowledge-service.js', () => ({
  knowledgeService: { workUnitFeedback: vi.fn(), extractFromExecution: vi.fn() },
}));

vi.mock('./knowledge-promoter.js', () => ({
  recordKnowledgeRefs: vi.fn(),
}));

vi.mock('../knowledge/knowledge-bus.service.js', () => ({
  knowledgeBus: { search: vi.fn().mockReturnValue([]), formatSearchForPrompt: vi.fn().mockReturnValue(''), recordPattern: vi.fn() },
}));

vi.mock('../knowledge/resolution.service.js', () => ({
  resolutionMatcher: { formatForPrompt: vi.fn().mockResolvedValue('') },
}));

vi.mock('../skills/skill-loader.js', () => ({
  skillLoaderService: { loadSkill: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../knowledge/consumers/prompt-builder.js', () => ({
  getLastInjectedIds: vi.fn().mockReturnValue([]),
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

/** Get the last prisma.goalExecution.update call's data payload that contains a failureType */
function lastFailurePayload(): Record<string, unknown> {
  const failureCalls = mockGoalExecUpdate.mock.calls.filter(
    (call: [{ where: { id: string }; data: Record<string, unknown> }]) => call[0]?.data?.failureType !== undefined
  );
  expect(failureCalls.length).toBeGreaterThanOrEqual(1);
  return failureCalls[failureCalls.length - 1][0].data;
}

/** Get the last prisma.goalExecution.update call's status value */
function lastStatusTransition(): string {
  const statusCalls = mockGoalExecUpdate.mock.calls.filter(
    (call: [{ where: { id: string }; data: Record<string, unknown> }]) => call[0]?.data?.status !== undefined
  );
  expect(statusCalls.length).toBeGreaterThanOrEqual(1);
  return statusCalls[statusCalls.length - 1][0].data.status as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  // retries exhausted so maybeRetryExecution returns false
  mockGoalExecFindUnique.mockResolvedValue({ retryCount: 3, input: null });
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

  test('retryable (retries exhausted) → status failed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'exit code 1',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('retryable');
    expect(lastStatusTransition()).toBe('failed');
  });

  test('infrastructure (retries exhausted) → status failed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'worktree directory ENOENT: /root/worktrees/abc123',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('infrastructure');
    expect(lastStatusTransition()).toBe('failed');
  });

  test('unknown (triage-agent action) → status failed', async () => {
    mockAgentExecute.mockResolvedValue({
      success: false,
      error: 'Something weird happened',
      sessionIds: [],
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const payload = lastFailurePayload();
    expect(payload.failureType).toBe('unknown');
    expect(lastStatusTransition()).toBe('failed');
  });
});
