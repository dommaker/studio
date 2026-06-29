/**
 * Behavioral tests for retry previousError injection
 *
 * AC:
 * - When execution is retried (retryCount > 0), the prompt contains the previous error message
 * - The previous error is formatted as a clear warning section (not buried in JSON)
 * - When retryCount is 0 (first attempt), no previous error section is injected
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
  mockGoalExecFindUnique: vi.fn().mockResolvedValue(null),
  mockAgentExecute: vi.fn().mockResolvedValue({ success: true, outputFiles: [], sessionCount: 1, totalDurationMs: 100, sessionIds: [] }),
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
    updateStepExecution: vi.fn().mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'running' }),
    checkGoalCompletion: vi.fn().mockResolvedValue(undefined),
  },
  parseJsonField: <T>(val: unknown, def: T): T => {
    if (val === null || val === undefined) return def;
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return def; } }
    return val as T;
  },
}));

vi.mock('../failure-classifier.js', () => ({
  classifyFailure: vi.fn().mockReturnValue('retryable'),
  classifyFailureAction: vi.fn().mockReturnValue({ failureClass: 'retryable', action: 'retry-execution' }),
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
  knowledgeService: { pipelineFeedback: vi.fn(), extractFromExecution: vi.fn() },
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
  buildSubAgentPrompt: vi.fn().mockReturnValue('base-prompt-content'),
  buildLegacyPrompt: vi.fn().mockReturnValue('base-prompt-content'),
  buildIntegrationPrompt: vi.fn().mockResolvedValue('base-prompt-content'),
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

function makeExec(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'exec-1',
    goalId: 'goal-1',
    stepIndex: 0,
    status: 'pending',
    input: JSON.stringify({ acGroup: { acs: ['test ac'], files: ['test.ts'] } }),
    retryCount: 0,
    error: null,
    ...overrides,
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
  mockAgentExecute.mockResolvedValue({ success: true, outputFiles: [], sessionCount: 1, totalDurationMs: 100, sessionIds: [] });
});

describe('retry previousError injection', () => {
  test('first attempt (retryCount=0) does not inject previous error', async () => {
    await dispatchStep(makeExec({ retryCount: 0 }), makeGoal(), makeCtx());

    expect(mockAgentExecute).toHaveBeenCalledOnce();
    const task = mockAgentExecute.mock.calls[0][0];
    expect(task.prompt).not.toContain('Previous Attempt Failed');
  });

  test('retry (retryCount=1) injects previous error message into prompt', async () => {
    const prevError = JSON.stringify({
      message: 'Max sessions (5) exhausted. Last error: worktree ENOENT',
      retryAttempt: 1,
      timestamp: Date.now(),
    });

    await dispatchStep(makeExec({ retryCount: 1, error: prevError }), makeGoal(), makeCtx());

    expect(mockAgentExecute).toHaveBeenCalledOnce();
    const task = mockAgentExecute.mock.calls[0][0];
    expect(task.prompt).toContain('Previous Attempt Failed');
    expect(task.prompt).toContain('Max sessions (5) exhausted');
    expect(task.prompt).toContain('Do NOT repeat the same approach');
  });

  test('retry prompt contains error as warning section (not raw JSON)', async () => {
    const prevError = JSON.stringify({
      message: 'Session 1 produced zero progress',
      retryAttempt: 2,
      timestamp: Date.now(),
    });

    await dispatchStep(makeExec({ retryCount: 2, error: prevError }), makeGoal(), makeCtx());

    const task = mockAgentExecute.mock.calls[0][0];
    expect(task.prompt).toContain('Previous Attempt Failed');
    expect(task.prompt).toContain('Session 1 produced zero progress');
    expect(task.prompt).not.toContain('"retryAttempt"');
    expect(task.prompt).not.toContain('"timestamp"');
  });

  test('retry with non-JSON error still injects the error message', async () => {
    await dispatchStep(
      makeExec({ retryCount: 1, error: 'plain text error from agent crash' }),
      makeGoal(),
      makeCtx(),
    );

    const task = mockAgentExecute.mock.calls[0][0];
    expect(task.prompt).toContain('Previous Attempt Failed');
    expect(task.prompt).toContain('plain text error from agent crash');
  });
});
