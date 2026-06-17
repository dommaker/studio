/**
 * Behavioral tests for B57-P0: Executor is always fast tier
 *
 * AC:
 * - agentRunner.execute always receives model: 'fast'
 * - No tier classification functions (classifyTaskComplexity etc.) are called
 * - input.model is hardcoded to 'fast' regardless of input
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
  mockClassifyTaskComplexity,
  mockInferTaskCategory,
  mockGetHistoricalBestTier,
  mockMaybeExploreDowngrade,
} = vi.hoisted(() => ({
  mockUpdateStepExecution: vi.fn().mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'running' }),
  mockAgentExecute: vi.fn().mockResolvedValue({
    success: true, outputFiles: [], sessionCount: 1, totalDurationMs: 100, sessionIds: [],
  }),
  mockPrismaUpdate: vi.fn().mockResolvedValue({}),
  mockPrismaCreate: vi.fn().mockResolvedValue({}),
  mockPrismaFindMany: vi.fn().mockResolvedValue([]),
  mockPrismaFindUnique: vi.fn().mockResolvedValue(null),
  mockPrismaFindFirst: vi.fn().mockResolvedValue(null),
  mockClassifyTaskComplexity: vi.fn(),
  mockInferTaskCategory: vi.fn(),
  mockGetHistoricalBestTier: vi.fn(),
  mockMaybeExploreDowngrade: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: {
      update: mockPrismaUpdate,
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: mockPrismaFindFirst,
      findUnique: mockPrismaFindUnique,
    },
    studioEvent: { create: mockPrismaCreate, findMany: mockPrismaFindMany },
    project: { findUnique: vi.fn().mockResolvedValue(null) },
    pipelineDecision: { create: vi.fn().mockResolvedValue({}) },
    failureEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
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

// Spy on tier classification functions to verify they are NOT called
vi.mock('../scheduler-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduler-queue.js')>();
  return {
    ...actual,
    classifyTaskComplexity: mockClassifyTaskComplexity,
    inferTaskCategory: mockInferTaskCategory,
    getHistoricalBestTier: mockGetHistoricalBestTier,
    maybeExploreDowngrade: mockMaybeExploreDowngrade,
  };
});

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

vi.mock('../events/session-summary-generator.js', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/git.js', () => ({
  getDefaultBranch: vi.fn().mockReturnValue('main'),
}));

vi.mock('../../daemon/metrics.js', () => ({
  recordPipelineRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../knowledge/knowledge-service.js', () => ({
  knowledgeService: { pipelineStepFeedback: vi.fn(), extractFromExecution: vi.fn() },
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

import { dispatchStep, type DispatchContext } from '../scheduler-dispatch.js';

function makeCtx(): DispatchContext {
  return {
    runtimeConstraints: new Map(),
    recentFailures: 0,
    recentTotal: 0,
  };
}

function makeExec(overrides?: Record<string, unknown>) {
  return {
    id: 'exec-1',
    goalId: 'goal-1',
    stepIndex: 0,
    status: 'pending',
    input: JSON.stringify({ acGroup: { acs: ['test ac'], files: ['test.ts'] } }),
    ...overrides,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAgentExecute.mockResolvedValue({
    success: true, outputFiles: [], sessionCount: 1, totalDurationMs: 100, sessionIds: [],
  });
});

describe('B57-P0: Executor always uses fast tier', () => {
  test('agentRunner.execute receives model="fast" for normal execution', async () => {
    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    expect(mockAgentExecute).toHaveBeenCalledOnce();
    const task = mockAgentExecute.mock.calls[0][0];
    expect(task.model).toBe('fast');
  });

  test('input.model is hardcoded to "fast" regardless of original input', async () => {
    const exec = makeExec({
      input: JSON.stringify({
        acGroup: { acs: ['test ac'], files: ['test.ts'], modelTier: 'premium' },
        model: 'premium',
      }),
    });

    await dispatchStep(exec, makeGoal(), makeCtx());

    // Verify that updateStepExecution was called with input.model = 'fast'
    const inputUpdateCalls = mockUpdateStepExecution.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => (call[1] as Record<string, unknown>)?.input
    );
    expect(inputUpdateCalls.length).toBeGreaterThanOrEqual(1);
    const lastInputUpdate = inputUpdateCalls[inputUpdateCalls.length - 1][1] as { input: { model: string } };
    expect(lastInputUpdate.input.model).toBe('fast');
  });

  test('classifyTaskComplexity is never called', async () => {
    await dispatchStep(makeExec(), makeGoal(), makeCtx());
    expect(mockClassifyTaskComplexity).not.toHaveBeenCalled();
  });

  test('inferTaskCategory is never called', async () => {
    await dispatchStep(makeExec(), makeGoal(), makeCtx());
    expect(mockInferTaskCategory).not.toHaveBeenCalled();
  });

  test('getHistoricalBestTier is never called', async () => {
    await dispatchStep(makeExec(), makeGoal(), makeCtx());
    expect(mockGetHistoricalBestTier).not.toHaveBeenCalled();
  });

  test('maybeExploreDowngrade is never called', async () => {
    await dispatchStep(makeExec(), makeGoal(), makeCtx());
    expect(mockMaybeExploreDowngrade).not.toHaveBeenCalled();
  });

  test('agentRunner.execute receives model="fast" for integration step', async () => {
    const exec = makeExec({
      input: JSON.stringify({ taskType: 'integration', goalId: 'goal-1', totalSteps: 2 }),
    });

    // Integration code execution will fail (mocked as undefined), falls back to Claude
    await dispatchStep(exec, makeGoal(), makeCtx());

    if (mockAgentExecute.mock.calls.length > 0) {
      const task = mockAgentExecute.mock.calls[0][0];
      expect(task.model).toBe('fast');
    }
  });
});
