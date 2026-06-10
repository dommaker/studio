/**
 * Scheduler Dispatch — dispatchStep 核心逻辑 + DispatchContext
 *
 * 从 goal-scheduler.ts 提取。prompt 构建和上下文收集在 scheduler-prompt.ts。
 */

import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { recordPipelineRun } from '../../daemon/metrics.js';
import { agentRunner } from '@dommaker/studio-agent';
import { goalService, parseJsonField } from './goal.service.js';
import { beforeAgentDispatch } from '@dommaker/studio-shared/harness/hooks';
import { generateSessionSummary } from '../events/session-summary-generator.js';
import { roleConfigService } from '../roles/role-config.service.js';
import { preferenceObserver } from '../knowledge/preference-observer.js';
import { getDefaultBranch } from '../../utils/git.js';

import {
  classifyTaskComplexity,
  inferTaskCategory,
  getHistoricalBestTier,
  maybeExploreDowngrade,
  getDispatchStrategy,
  updateDispatchOutcome,
  parseAgentTokenUsage,
  persistRoutingStats,
  type ClassificationRecord,
  type TierRoutingConfig,
} from './scheduler-queue.js';

import {
  buildSubAgentPrompt,
  buildLegacyPrompt,
  buildIntegrationPrompt,
  getSiblingContext,
  getCompanyKnowledge,
  getProjectRepoPath,
  findTaskBranch,
  runIntegrationInCode,
} from './scheduler-prompt.js';

const MAX_CONCURRENT = 5;
const MAX_RETRIES = 3;
const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

// ─── Dispatch Context ───

export interface DispatchContext {
  runtimeConstraints: Map<string, string[]>;
  routingOverrides: Map<string, string>;
  tokenGatedGoals: Set<string>;
  recentClassifications: ClassificationRecord[];
  explorationCount: number;
  explorationSuccess: number;
  recentFailures: number;
  recentTotal: number;
  tierRoutingConfig: TierRoutingConfig;
}

// ─── Main Dispatch Function ───

/** 主 dispatch 函数：从 GoalScheduler.dispatchStep 提取 */
export async function dispatchStep(
  execWithStep: any,
  goal: any,
  ctx: DispatchContext,
): Promise<void> {
  const { id: executionId, stepIndex, _baseBranchExecId } = execWithStep;
  const input = parseJsonField<Record<string, any> | null>(execWithStep.input, null);

  // Phase 3: dispatch 前 harness 检查
  try {
    await beforeAgentDispatch({
      operation: 'code_implementation',
      taskDescription: input?.taskType === 'integration' ? 'Integration step' : (input?.acGroup?.acs?.join('; ') || ''),
      projectPath: await getProjectRepoPath(goal),
      hasWorktree: true,
      hasRequirement: true,
      hasSingleTask: true,
      hasVerificationEvidence: true,
    });
  } catch (err) {
    logger.warn('[GoalScheduler] beforeAgentDispatch failed, continuing', { executionId, error: String(err) });
  }

  // ROLE-001: 加载 Executor 的角色约束
  let roleConstraints: string[] = [];
  try {
    const companyId = goal.companyId || (goal.context as any)?.companyId;
    if (companyId) {
      const execConfig = await roleConfigService.getOrCreate('executor', companyId);
      roleConstraints = parseJsonField<string[]>(execConfig.boundConstraints, []);
    }
  } catch (e) {
    logger.warn('[GoalScheduler] Failed to load role config, using defaults', { executionId, error: String(e) });
  }

  // BP-018: 注入运行时约束
  const runtimeConstraints = ctx.runtimeConstraints.get(goal.id);
  if (runtimeConstraints?.length) {
    roleConstraints = [...roleConstraints, ...runtimeConstraints];
    logger.info('[BP-018] Injected runtime constraints', { executionId, count: runtimeConstraints.length });
  }

  // G5/Q4: 动态模型路由
  const autoTier = classifyTaskComplexity(input, '', ctx.tierRoutingConfig);
  const taskCategory = inferTaskCategory('', input);
  const historicalTier = getHistoricalBestTier(taskCategory, ctx.recentClassifications);
  const baseTier = historicalTier || autoTier;
  const { tier: exploredTier, exploring } = maybeExploreDowngrade(baseTier, taskCategory, ctx.tierRoutingConfig.explorationRate);
  if (exploring) ctx.explorationCount++;
  let tier: string = exploredTier;
  if (ctx.routingOverrides.has(taskCategory) && tier === 'premium') {
    tier = ctx.routingOverrides.get(taskCategory)!;
  }
  if (ctx.tokenGatedGoals.has(goal.id) && tier === 'premium') tier = 'standard';

  // O2c: Adaptive routing
  try {
    const recentSessions = await prisma.studioEvent.findMany({
      where: { agentRole: 'executor', tokenInput: { gt: 0 } },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
    if (recentSessions.length >= 5) {
      const avgCacheHitRate = recentSessions.reduce((sum, e) =>
        sum + (e.tokenCacheRead || 0) / Math.max(e.tokenInput || 1, 1), 0) / recentSessions.length;
      if (avgCacheHitRate < 0.3 && tier === 'premium') {
        tier = 'standard';
        logger.info('[GoalScheduler] Adaptive routing: downgraded to standard due to low cache hit rate', { avgCacheHitRate: avgCacheHitRate.toFixed(3) });
      }
    }
  } catch { /* best-effort */ }

  // OBS-6: 注入分类上下文到 input
  if (input) {
    input.model = tier;
    (input as any).classifyReason = classifyTaskComplexity(input, '', ctx.tierRoutingConfig);
    (input as any).taskCategory = taskCategory;
    (input as any).riskHits = (input?.acGroup?.acs ? JSON.stringify(input.acGroup.acs).toLowerCase().match(/(migration|migrate|auth|authentication|security|financial|payment|encrypt|crypto)/gi)?.length || 0 : 0);
    (input as any).estimatedLines = (input?.acGroup?.acs?.length || 1) * 15;
    await goalService.updateStepExecution(executionId, { input }).catch(() => {});
  }

  await goalService.updateStepExecution(executionId, { status: 'running' });

  // 构建 prompt
  const isSubAgent = input?.taskType === 'sub-agent';
  const isIntegration = input?.taskType === 'integration';
  const siblingContext = isSubAgent
    ? await getSiblingContext(goal.id, executionId, stepIndex)
    : '';
  const companyKnowledge = isSubAgent
    ? await getCompanyKnowledge(goal.id, input)
    : '';

  let prompt: string;
  if (isIntegration) {
    prompt = await buildIntegrationPrompt(goal.id);
  } else if (isSubAgent) {
    prompt = buildSubAgentPrompt(input, siblingContext, companyKnowledge);
  } else {
    prompt = buildLegacyPrompt(input);
  }

  const strategy = getDispatchStrategy(ctx.recentFailures, ctx.recentTotal);
  const effectiveConcurrency = strategy === 'conservative' ? 2 : MAX_CONCURRENT;

  // Track classification
  ctx.recentClassifications.push({
    time: new Date().toISOString(),
    executionId,
    taskType: input?.taskType || 'sub-agent',
    acCount: input?.acGroup?.acs?.length || 1,
    fileCount: (input?.acGroup?.files || []).length,
    classified: autoTier,
    final: tier,
    taskCategory,
  });
  if (ctx.recentClassifications.length > 200) ctx.recentClassifications.shift();
  persistRoutingStats(ctx.recentClassifications);
  const dispatchStart = Date.now();
  logger.info('[GoalScheduler] Dispatching', {
    strategy,
    effectiveConcurrency,
    executionId,
    goalId: goal.id,
    stepIndex,
    taskType: input?.taskType || 'sub-agent',
    tier: autoTier === tier ? tier : `${tier} (auto-classified: ${autoTier})`,
    hasRoleConstraints: roleConstraints.length > 0,
    hasSiblingContext: !!siblingContext,
    siblingContextSize: siblingContext?.length || 0,
    hasCompanyKnowledge: !!companyKnowledge,
    companyKnowledgeSize: companyKnowledge?.length || 0,
  });

  // Knowledge context injection — unified via buildKnowledgeContext
  let knowledgeContext = '';
  try {
    const { buildKnowledgeContext } = await import('../knowledge/consumers/prompt-builder.js');
    knowledgeContext = await buildKnowledgeContext('executor');
  } catch { /* best-effort */ }

  // AS-019: task-relevant knowledge search (replaces generic getRecentContext)
  try {
    const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
    const searchResults = knowledgeBus.search(prompt || goal.title, { limit: 5 });
    if (searchResults.length > 0) {
      const searchContext = knowledgeBus.formatSearchForPrompt(searchResults);
      if (searchContext) knowledgeContext += searchContext;
    }
  } catch { /* best-effort */ }

  try {
    const { resolutionMatcher } = await import('../knowledge/resolution.service.js');
    const rkbContext = await resolutionMatcher.formatForPrompt();
    if (rkbContext) knowledgeContext += '\n## 已知回归模式（Resolution Knowledge Base）\n' + rkbContext;
  } catch { /* best-effort */ }

  // Index summary already included in buildKnowledgeContext above

  const goalContext = (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) || {};
  const sourceChannelId = goalContext.sourceChannelId as string | undefined;

  let pmoNumber = '';
  try {
    const projectId = goalContext.projectId as string | undefined;
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pmoNumber: true } });
      if (project?.pmoNumber) pmoNumber = project.pmoNumber;
    }
  } catch { /* best-effort */ }

  // Integration step — code execution (with 7min outer timeout)
  if (isIntegration) {
    const INTEGRATION_TIMEOUT_MS = 7 * 60 * 1000;
    try {
      const result = await Promise.race([
        runIntegrationInCode(goal.id, executionId, pmoNumber),
        new Promise<{ success: false; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('Integration timeout (7min)')), INTEGRATION_TIMEOUT_MS)
        ),
      ]);
      if (result.success) {
        await goalService.updateStepExecution(executionId, { status: 'succeeded' });
        const newState = updateDispatchOutcome({ failures: ctx.recentFailures, total: ctx.recentTotal }, true);
        ctx.recentFailures = newState.failures;
        ctx.recentTotal = newState.total;
        logger.info('[GoalScheduler] Integration (code) succeeded', {
          goalId: goal.id, executionId, durationMs: Date.now() - dispatchStart,
        });
        return;
      }
      // Non-throw failure — log context before falling through to Claude
      logger.warn('[GoalScheduler] Integration (code) failed, falling back to Claude', {
        goalId: goal.id, executionId, error: result.error,
      });
    } catch (err) {
      logger.warn('[GoalScheduler] Integration (code) threw, falling back to Claude', { goalId: goal.id, error: String(err) });
    }
  }

  // AgentExecutor
  const projectRepoDir = await getProjectRepoPath(goal);
  try {
    const onProgress = buildOnProgress(sourceChannelId, goal.id, executionId);
    const result = await agentRunner.execute({
      id: executionId,
      executionId,
      agentType: 'claude',
      model: (input?.model as string) || autoTier,
      prompt,
      onProgress,
      parameters: {
        goalExecutionId: executionId,
        goalId: goal.id,
        acGroup: input?.acGroup || undefined,
        analystContext: (input?.acGroup as any)?._analystContext || null,
        hasWorktree: true,
        repoDir: projectRepoDir,
        ...(_baseBranchExecId ? { baseBranch: await findTaskBranch(_baseBranchExecId, projectRepoDir) || getDefaultBranch(projectRepoDir) } : {}),
        knowledgeContext,
        sourceChannelId,
        roleConstraints,
        ...(pmoNumber ? { pmoNumber } : {}),
      },
    });

    const dispatchDuration = Date.now() - dispatchStart;

    if (result.sessionIds?.length) {
      for (const sid of result.sessionIds) {
        generateSessionSummary(sid).catch((err: unknown) => {
          logger.warn('[GoalScheduler] SessionSummary generation failed', { sessionId: sid, error: String(err) });
        });
      }
    }

    const newState = updateDispatchOutcome({ failures: ctx.recentFailures, total: ctx.recentTotal }, result.success);
    ctx.recentFailures = newState.failures;
    ctx.recentTotal = newState.total;
    const cls = ctx.recentClassifications.find(c => c.executionId === executionId);
    if (cls) {
      cls.outcome = result.success ? 'success' : 'failure';
      cls.durationMs = dispatchDuration;
      if (cls.final !== cls.classified) {
        if (result.success) ctx.explorationSuccess++;
        logger.info('[GoalScheduler] ε-greedy result', {
          classified: cls.classified, used: cls.final,
          success: result.success, explorationTotal: ctx.explorationCount,
          explorationSuccess: ctx.explorationSuccess,
        });
      }
    }
    preferenceObserver.updateFromRoutingFeedback(ctx.recentClassifications.map(c => ({
      taskId: c.executionId,
      tier: c.final as 'premium' | 'standard' | 'fast',
      result: c.outcome as 'success' | 'failure',
      duration: c.durationMs || 0,
      timestamp: Date.now(),
    }))).catch((e: any) => { logger.warn('[GoalScheduler] preferenceObserver failed', { error: String(e) }); });

    if (result.success) {
      await handleDispatchSuccess(executionId, goal, input, tier, strategy, result, dispatchStart, dispatchDuration, ctx);
    } else {
      await handleDispatchFailure(executionId, goal, input, tier, strategy, result, dispatchDuration, ctx);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await goalService.updateStepExecution(executionId, { status: 'failed', error: errorMsg });
    logger.error('[GoalScheduler] Agent error', { executionId, error: errorMsg });
    try {
      const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
      await knowledgeBus.recordPattern({
        source: 'executor',
        type: 'failure',
        title: `[Executor] dispatch error: ${errorMsg.slice(0, 80)}`,
        content: `ExecutionId: ${executionId}\nError: ${errorMsg}`,
        severity: 'warning',
        timestamp: Date.now(),
      });
    } catch { /* non-blocking */ }
  }
}

// ─── Result Handlers ───

/** dispatch 成功后的处理：记录 metrics、persist decisions */
async function handleDispatchSuccess(
  executionId: string,
  goal: any,
  input: Record<string, any> | null,
  tier: string,
  strategy: string,
  result: any,
  dispatchStart: number,
  dispatchDuration: number,
  ctx: DispatchContext,
): Promise<void> {
  const worktreeDir = path.join(WORKTREES_DIR, executionId);
  const execOutput = (result as any).output || (result as any).stdout?.slice(0, 5000);

  // Capture HEAD commit SHA for integration step to use
  let headCommit: string | undefined;
  try {
    headCommit = execSync('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }).trim();
  } catch { /* worktree may be cleaned up */ }

  const outputData: Record<string, unknown> = {};
  if (execOutput) {
    try {
      const parsed = JSON.parse(execOutput);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        Object.assign(outputData, parsed);
      } else {
        outputData.raw = execOutput;
      }
    } catch { outputData.raw = execOutput; }
  }
  if (headCommit) outputData.headCommit = headCommit;

  await goalService.updateStepExecution(executionId, {
    status: 'succeeded',
    ...(Object.keys(outputData).length > 0 ? { output: JSON.stringify(outputData) } : {}),
  });
  const tokenUsage = parseAgentTokenUsage(worktreeDir);
  recordPipelineRun({
    source: 'pipeline', phase: 'executor',
    taskName: goal.title,
    model: tokenUsage.model || (typeof input === 'object' ? (input?.model as string) || 'standard' : 'standard'),
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    cacheHitTokens: tokenUsage.cacheHitTokens,
    durationMs: result.totalDurationMs || dispatchDuration,
    success: true,
    sessionId: executionId,
    goalId: goal.id,
  }).catch((e: any) => { logger.warn('[GoalScheduler] recordPipelineRun failed', { error: String(e) }); });
  try {
    await prisma.studioEvent.create({
      data: {
        type: 'pipeline_run',
        source: 'goal-scheduler',
        executionId,
        payload: JSON.stringify({
          goalId: goal.id,
          success: true,
          model: tokenUsage.model,
          durationMs: result.totalDurationMs || dispatchDuration,
        }),
      },
    });
  } catch (e) {
    logger.warn('[GoalScheduler] StudioEvent write failed', { error: String(e), executionId });
  }
  try {
    const execInput = (input as Record<string, any> | null) || {};
    const acs = execInput?.acGroup?.acs || [];
    const files = execInput?.acGroup?.files || [];
    await prisma.pipelineDecision.create({
      data: {
        executionId,
        goalId: goal.id,
        tier: (execInput.modelTier as string) || 'standard',
        reason: execInput.classifyReason || 'default',
        acCount: acs.length || 0,
        fileCount: files.length || 0,
        taskCategory: (execInput.taskCategory as string) || undefined,
        riskHits: execInput.riskHits || 0,
        estimatedLines: execInput.estimatedLines,
        featuresJson: JSON.stringify({ acs: acs.length, files: files.length, tier: execInput.modelTier }),
      },
    });
  } catch (e) {
    logger.warn('[GoalScheduler] PipelineDecision write failed', { error: String(e) });
  }
  try {
    const g = await prisma.goal.findUnique({ where: { id: goal.id }, select: { context: true } });
    const gc = (typeof g?.context === 'string' ? JSON.parse(g.context) : g?.context) || {};
    const prevTokens = (gc._cumulativeTokens as number) || 0;
    const thisTokens = (tokenUsage.inputTokens || 0) + (tokenUsage.cacheHitTokens || 0);
    gc._cumulativeTokens = prevTokens + thisTokens;
    await prisma.goal.update({
      where: { id: goal.id },
      data: { context: gc as any },
    });
  } catch { /* best-effort */ }

  logger.info('[GoalScheduler] Agent succeeded', {
    executionId,
    goalId: goal.id,
    sessionCount: result.sessionCount,
    tokens: tokenUsage,
    dispatchDurationMs: dispatchDuration,
    tier,
    strategy,
  });

  // ── Knowledge feedback loop: pipelineStepFeedback + extractFromExecution + recordKnowledgeRefs ──
  try {
    const { knowledgeService } = await import('../knowledge/knowledge-service.js');
    await knowledgeService.pipelineStepFeedback({
      goalId: goal.id,
      executionId,
      phase: 'executor',
      success: true,
      durationMs: result.totalDurationMs || dispatchDuration,
      tokensUsed: tokenUsage.inputTokens + tokenUsage.outputTokens,
    });
  } catch { /* non-blocking */ }
  try {
    const { knowledgeService } = await import('../knowledge/knowledge-service.js');
    const execOutput = (result as any).output || (result as any).stdout || '';
    await knowledgeService.extractFromExecution({
      task: goal.title || executionId,
      diff: execOutput.slice(0, 5000),
      success: true,
      duration: result.totalDurationMs || dispatchDuration,
      agentType: 'executor',
      consumedKnowledge: [],
    });
  } catch { /* non-blocking */ }
  try {
    const worktreeDir = path.join(WORKTREES_DIR, executionId);
    const { recordKnowledgeRefs } = await import('./knowledge-promoter.js');
    const completionOutput = (result as any).output || {};
    recordKnowledgeRefs(completionOutput, worktreeDir);
  } catch { /* non-blocking */ }
}

/**
 * 检查执行是否可以重试。retryCount < MAX_RETRIES → 重置为 pending，返回 true。
 * 已达上限 → 返回 false，由调用方走正常失败流程。
 */
export async function maybeRetryExecution(
  executionId: string,
  error: string,
  maxRetries: number = MAX_RETRIES,
): Promise<boolean> {
  const exec = await prisma.goalExecution.findUnique({
    where: { id: executionId },
    select: { retryCount: true },
  });
  if (!exec) return false;

  if (exec.retryCount >= maxRetries) {
    logger.info('[GoalScheduler] Retry exhausted', { executionId, retryCount: exec.retryCount, maxRetries });
    return false;
  }

  await prisma.goalExecution.update({
    where: { id: executionId },
    data: {
      status: 'pending',
      retryCount: exec.retryCount + 1,
      error: JSON.stringify({
        message: error,
        retryAttempt: exec.retryCount + 1,
        timestamp: Date.now(),
      }),
      startedAt: null,
      completedAt: null,
    },
  });

  logger.warn('[GoalScheduler] Retrying execution', {
    executionId,
    retryCount: exec.retryCount + 1,
    maxRetries,
  });
  return true;
}

/** dispatch 失败后的处理：记录 metrics、feedback loop */
async function handleDispatchFailure(
  executionId: string,
  goal: any,
  input: Record<string, any> | null,
  tier: string,
  strategy: string,
  result: any,
  dispatchDuration: number,
  ctx: DispatchContext,
): Promise<void> {
  // Retry check: if retryable, reset to pending and skip failure flow
  const errorStr = result.error || 'Agent execution failed';
  const retried = await maybeRetryExecution(executionId, errorStr);
  if (retried) return;

  const worktreeDir = path.join(WORKTREES_DIR, executionId);
  await goalService.updateStepExecution(executionId, {
    status: 'failed',
    error: errorStr,
  });
  const failTokens = parseAgentTokenUsage(worktreeDir);
  recordPipelineRun({
    source: 'pipeline', phase: 'executor',
    taskName: goal.title,
    model: failTokens.model || (typeof input === 'object' ? (input?.model as string) || 'standard' : 'standard'),
    inputTokens: failTokens.inputTokens,
    outputTokens: failTokens.outputTokens,
    cacheHitTokens: failTokens.cacheHitTokens,
    durationMs: result.totalDurationMs || dispatchDuration,
    success: false,
    error: result.error || 'Agent execution failed',
    sessionId: executionId,
    goalId: goal.id,
  }).catch((e: any) => { logger.warn('[GoalScheduler] recordPipelineRun (failure) failed', { error: String(e) }); });
  const errDetail = result.error || 'Agent execution failed';
  try {
    await prisma.studioEvent.create({
      data: {
        type: 'pipeline_run',
        source: 'goal-scheduler',
        executionId,
        payload: JSON.stringify({
          goalId: goal.id,
          executionId,
          success: false,
          error: errDetail,
        }),
      },
    });
  } catch (e) {
    logger.warn('[GoalScheduler] StudioEvent (failure) write failed', { error: String(e) });
  }
  logger.warn('[GoalScheduler] Agent failed', {
    executionId,
    goalId: goal.id,
    error: result.error,
    dispatchDurationMs: dispatchDuration,
    tier,
    strategy,
  });

  // ── Knowledge feedback loop: pipelineStepFeedback (failure) ──
  try {
    const { knowledgeService } = await import('../knowledge/knowledge-service.js');
    await knowledgeService.pipelineStepFeedback({
      goalId: goal.id,
      executionId,
      phase: 'executor',
      success: false,
      durationMs: result.totalDurationMs || dispatchDuration,
      error: result.error || 'Agent execution failed',
    });
  } catch { /* non-blocking */ }

  try {
    const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
    await knowledgeBus.recordPattern({
      source: 'executor',
      type: 'failure',
      title: `[Executor] ${goal.title?.slice(0, 60) || executionId}: ${(result.error || 'failed').slice(0, 80)}`,
      content: `Goal: ${goal.id}\nError: ${result.error}\nTier: ${tier}\nStrategy: ${strategy}`,
      severity: 'warning',
      timestamp: Date.now(),
    });
  } catch { /* non-blocking */ }

  // ── extractFromExecution (failure): learn from failed execution ──
  try {
    const { knowledgeService } = await import('../knowledge/knowledge-service.js');
    await knowledgeService.extractFromExecution({
      task: goal.title || executionId,
      diff: (result.error || '').slice(0, 5000),
      success: false,
      duration: result.totalDurationMs || dispatchDuration,
      agentType: 'executor',
      consumedKnowledge: [],
    });
  } catch { /* non-blocking */ }

  // ── recordKnowledgeRefs: scan worktree for [REF:xxx] markers ──
  try {
    const { recordKnowledgeRefs } = await import('./knowledge-promoter.js');
    recordKnowledgeRefs({}, worktreeDir);
  } catch { /* non-blocking */ }
}

// ─── Progress Callback ───

/** 构建实时进度回调 */
function buildOnProgress(
  sourceChannelId: string | undefined,
  goalId: string,
  executionId: string,
) {
  return async (progress: any, session: number) => {
    if (!sourceChannelId) return;
    try {
      const { channelMessageService } = await import('../channels/channel-message.service.js');
      const pct = progress.allComplete ? 100
        : progress.completedSteps?.length
          ? Math.min(95, Math.round((progress.completedSteps.length / Math.max(progress.completedSteps.length + (progress.testResults?.failed ? 1 : 0), 1)) * 100))
          : session * 15;
      const statusIcon = progress.allComplete ? '✅' : progress.testResults?.failed ? '⚠️' : '🔄';
      const lines = [
        `### ${statusIcon} Agent 进度 — Session ${session}`,
        '',
        `**当前步骤**: ${progress.currentStep || '初始化中...'}`,
        `**已完成**: ${progress.completedSteps?.join(', ') || '无'}`,
        `**测试**: ${progress.testResults?.passed || 0} passed / ${progress.testResults?.failed || 0} failed / ${progress.testResults?.total || 0} total`,
        `**备注**: ${progress.notes || '无'}`,
        '',
        `---`,
        `*${pct}% 完成*`,
      ].join('\n');
      await channelMessageService.createAgentMessage(sourceChannelId, 'Executor', lines, {
        meta: { cardType: 'agent_progress', goalId, cardData: { executionId, session, pct } },
      });
    } catch { /* best-effort */ }
  };
}
