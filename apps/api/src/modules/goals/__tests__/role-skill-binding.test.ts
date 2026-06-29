/**
 * Role→Skill 绑定契约测试
 *
 * AC:
 * 1. executor 有 boundSkills 时 prompt 包含对应 skill 内容
 * 2. boundSkills 为空时无 skill 注入
 * 3. boundSkills 包含不存在的 skill name 时静默跳过不报错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    pipelineDecision: { create: vi.fn() },
    project: { findUnique: vi.fn() },
    goalExecution: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workUnit: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  eventBus: { emit: vi.fn() },
  getModelForTier: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { execute: vi.fn().mockResolvedValue({ success: true, sessionIds: [], output: '{}' }) },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeAgentDispatch: vi.fn(),
}));

vi.mock('../knowledge/consumers/prompt-builder.js', () => ({
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
}));

vi.mock('../knowledge/knowledge-bus.service.js', () => ({
  knowledgeBus: { search: vi.fn().mockReturnValue([]), formatSearchForPrompt: vi.fn().mockReturnValue(''), recordPattern: vi.fn() },
}));

vi.mock('../knowledge/resolution.service.js', () => ({
  resolutionMatcher: { formatForPrompt: vi.fn().mockResolvedValue('') },
}));

vi.mock('../knowledge/preference-observer.js', () => ({
  preferenceObserver: { updateFromRoutingFeedback: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../events/session-summary-generator.js', () => ({
  generateSessionSummary: vi.fn(),
}));

vi.mock('../../daemon/metrics.js', () => ({
  recordExecution: vi.fn(),
}));

vi.mock('../../utils/git.js', () => ({
  getDefaultBranch: vi.fn().mockReturnValue('main'),
}));

vi.mock('../knowledge/knowledge-service.js', () => ({
  knowledgeService: { pipelineFeedback: vi.fn(), extractFromExecution: vi.fn() },
}));

vi.mock('./knowledge-promoter.js', () => ({
  recordKnowledgeRefs: vi.fn(),
}));

vi.mock('./failure-classifier.js', () => ({
  classifyFailure: vi.fn().mockReturnValue('retryable'),
  classifyFailureAction: vi.fn().mockReturnValue({ failureClass: 'retryable', action: 'retry-execution' }),
}));

vi.mock('./execution-alarm.js', () => ({
  onPhaseFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./integration-rollback.js', () => ({
  rollbackToIntegrationStep: vi.fn(),
  parseIntegrationFailureType: vi.fn(),
}));

vi.mock('../knowledge/consumers/prompt-builder.js', () => ({
  getLastInjectedIds: vi.fn().mockReturnValue([]),
}));

const mockLoadSkill = vi.fn();

vi.mock('../skills/skill-loader.js', () => ({
  skillLoaderService: { loadSkill: mockLoadSkill },
}));

vi.mock('../roles/role-config.service.js', () => ({
  roleConfigService: { getOrCreate: vi.fn() },
}));

vi.mock('./goal.service.js', () => ({
  goalService: {
    updateStepExecution: vi.fn().mockResolvedValue({ goalId: 'goal-1', status: 'running' }),
  },
  parseJsonField: (val: unknown, fallback: unknown) => {
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return fallback; } }
    return val ?? fallback;
  },
}));

vi.mock('./goal-lifecycle.js', () => ({
  updateStepExecution: vi.fn().mockResolvedValue({ id: 'exec-1', goalId: 'goal-1', status: 'running' }),
  cancelGoalExecution: vi.fn(),
  retryGoalExecution: vi.fn(),
  checkGoalCompletion: vi.fn().mockResolvedValue(undefined),
  handleGoalFailed: vi.fn(),
  recordGoalCompletion: vi.fn(),
}));

vi.mock('./scheduler-queue.js', () => ({
  classifyTaskComplexity: vi.fn().mockReturnValue('standard'),
  inferTaskCategory: vi.fn().mockReturnValue('general'),
  getHistoricalBestTier: vi.fn().mockReturnValue(null),
  maybeExploreDowngrade: vi.fn().mockImplementation((tier: string) => ({ tier, exploring: false })),
  getDispatchStrategy: vi.fn().mockReturnValue('normal'),
  updateDispatchOutcome: vi.fn().mockReturnValue({ failures: 0, total: 1 }),
  parseAgentTokenUsage: vi.fn().mockReturnValue({ model: 'standard', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 }),
  persistRoutingStats: vi.fn(),
}));

vi.mock('./scheduler-prompt.js', () => ({
  buildSubAgentPrompt: vi.fn().mockReturnValue('base-prompt'),
  buildLegacyPrompt: vi.fn().mockReturnValue('base-prompt'),
  buildIntegrationPrompt: vi.fn().mockResolvedValue('base-prompt'),
  getSiblingContext: vi.fn().mockResolvedValue(''),
  getCompanyKnowledge: vi.fn().mockResolvedValue(''),
  getProjectRepoPath: vi.fn().mockResolvedValue('/tmp/test-repo'),
  findTaskBranch: vi.fn().mockResolvedValue(null),
  runIntegrationInCode: vi.fn(),
}));

const { roleConfigService } = await import('../roles/role-config.service.js');
const { dispatchStep } = await import('../scheduler-dispatch.js');
const { agentRunner } = await import('@dommaker/studio-agent');

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    title: 'Test Goal',
    companyId: 'company-1',
    context: '{}',
    ...overrides,
  };
}

function makeExec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    stepIndex: 0,
    input: JSON.stringify({
      taskType: 'sub-agent',
      acGroup: { id: 'g1', acs: ['AC1'], files: [], dependencies: [], implementationNotes: '' },
    }),
    ...overrides,
  };
}

function makeCtx() {
  return {
    runtimeConstraints: new Map(),
    recentFailures: 0,
    recentTotal: 0,
  };
}

describe('Role-Skill binding in scheduler-dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executor with boundSkills includes skill prompts in dispatch prompt', async () => {
    vi.mocked(roleConfigService.getOrCreate).mockResolvedValue({
      roleType: 'executor',
      companyId: 'company-1',
      systemPrompt: '',
      modelTier: 'standard',
      boundSkills: ['green-only-tdd'],
      boundConstraints: [],
      boundMcps: [],
      boundTools: [],
      evolutionHooks: {} as any,
    });

    mockLoadSkill.mockResolvedValue({
      skillId: 'file:green-only-tdd',
      name: 'green-only-tdd',
      prompt: '## TDD Workflow\n1. Write failing test',
      tools: [],
      tier: 'fast',
      loadedAt: new Date(),
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const executeMock = vi.mocked(agentRunner.execute);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0][0];
    const prompt = callArgs.prompt as string;
    expect(prompt).toMatch(/TDD|测试|test/i);
  });

  it('executor with empty boundSkills does not inject skill prompts', async () => {
    vi.mocked(roleConfigService.getOrCreate).mockResolvedValue({
      roleType: 'executor',
      companyId: 'company-1',
      systemPrompt: '',
      modelTier: 'standard',
      boundSkills: [],
      boundConstraints: [],
      boundMcps: [],
      boundTools: [],
      evolutionHooks: {} as any,
    });

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const executeMock = vi.mocked(agentRunner.execute);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0][0];
    expect(callArgs.prompt).not.toContain('Bound Skills');
  });

  it('boundSkills with nonexistent skill name skips silently', async () => {
    vi.mocked(roleConfigService.getOrCreate).mockResolvedValue({
      roleType: 'executor',
      companyId: 'company-1',
      systemPrompt: '',
      modelTier: 'standard',
      boundSkills: ['nonexistent-skill'],
      boundConstraints: [],
      boundMcps: [],
      boundTools: [],
      evolutionHooks: {} as any,
    });

    mockLoadSkill.mockResolvedValue(null);

    await dispatchStep(makeExec(), makeGoal(), makeCtx());

    const executeMock = vi.mocked(agentRunner.execute);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0][0];
    expect(callArgs.prompt).not.toContain('Bound Skills');
  });
});
