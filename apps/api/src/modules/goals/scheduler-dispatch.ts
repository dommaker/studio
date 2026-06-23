/**
 * Scheduler Dispatch — dispatchStep 核心逻辑 + DispatchContext
 *
 * 从 goal-scheduler.ts 提取。prompt 构建和上下文收集在 scheduler-prompt.ts。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'node:fs';
import { execSync } from 'child_process';
import { prisma } from '@dommaker/studio-prisma';
import { logger, getModelForTier, type ModelTier } from '@dommaker/studio-shared';
import { recordPipelineRun } from '../../daemon/metrics.js';
import { agentRunner } from '@dommaker/studio-agent';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { EXECUTION_TO_WORKUNIT_STATUS, mapExecutionStatuses } from '../workunit/status-mapping.js';
import { parseJsonField } from './goal.service.js';
import { beforeAgentDispatch } from '@dommaker/studio-shared/harness/hooks';
import { generateSessionSummary } from '../events/session-summary-generator.js';
import { roleConfigService } from '../roles/role-config.service.js';
import { getDefaultBranch } from '../../utils/git.js';

import {
  getDispatchStrategy,
  updateDispatchOutcome,
  parseAgentTokenUsage,
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
import { classifyFailure, classifyFailureAction } from './failure-classifier.js';
import { onPhaseFailure } from './pipeline-alarm.js';
import { rollbackToIntegrationStep, parseIntegrationFailureType, type IntegrationResult } from './integration-rollback.js';

const workUnitService = new WorkUnitService(prisma);

const MAX_CONCURRENT = 5;
const MAX_RETRIES = 3;
const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

// ─── B57-P2: Per-phase timeout configuration ───

/**
 * 返回指定 phase 的超时毫秒数。
 * 所有 execution phase 统一 15min (fast tier)。
 * Review/Deploy/Knowledge 不走 GoalExecution，无需覆盖。
 */
export function getTimeoutForPhase(phase: string): number {
  switch (phase) {
    case 'analyst': return 15 * 60_000;
    case 'executing': return 15 * 60_000;
    case 'integration': return 15 * 60_000;
    case 'review-fix': return 15 * 60_000;
    default: return 15 * 60_000;
  }
}

// ─── Dispatch Context ───

export interface DispatchContext {
  runtimeConstraints: Map<string, string[]>;
  recentFailures: number;
  recentTotal: number;
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

  // ROLE-001: 加载 Executor 的角色约束 + boundSkills
  let roleConstraints: string[] = [];
  let boundSkillNames: string[] = [];
  try {
    const companyId = goal.companyId || (goal.context as any)?.companyId;
    if (companyId) {
      const execConfig = await roleConfigService.getOrCreate('executor', companyId);
      roleConstraints = parseJsonField<string[]>(execConfig.boundConstraints, []);
      boundSkillNames = execConfig.boundSkills || [];
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

  // B57-P0: Executor is always fast-only — no tier classification
  const tier = 'fast';
  if (input) {
    input.model = 'fast';
    await workUnitService.update(executionId, { metadata: { input: JSON.stringify(input) } }).catch(() => {});
  }

  // B57-P1: Set timeoutAt when execution starts running
  const taskType = input?.taskType as string | undefined;
  const phase = taskType === 'integration' ? 'integration'
    : taskType === 'review-fix' ? 'review-fix'
    : 'executing';
  const timeoutAt = new Date(Date.now() + getTimeoutForPhase(phase));
  await workUnitService.update(executionId, { timeoutAt });
  await workUnitService.transitionStatus(executionId, 'active');

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

  // P6.5: boundSkills metadata injection
  if (boundSkillNames.length > 0) {
    try {
      const { skillLoaderService } = await import('../skills/skill-loader.js');
      const skillPrompts: string[] = [];
      for (const skillName of boundSkillNames) {
        const loaded = await skillLoaderService.loadSkill({ sessionId: executionId, skillName, agentType: 'executor' });
        if (loaded?.prompt) skillPrompts.push(loaded.prompt);
      }
      if (skillPrompts.length > 0) {
        prompt += '\n\n## Bound Skills\n' + skillPrompts.join('\n\n');
      }
    } catch (e) {
      logger.warn('[GoalScheduler] Failed to load boundSkills', { executionId, error: String(e) });
    }
  }

  // Retry: inject previous error so the new session doesn't repeat the same approach
  const retryCount = (execWithStep as Record<string, unknown>).retryCount as number | undefined;
  if (retryCount && retryCount > 0) {
    const rawError = (execWithStep as Record<string, unknown>).error as string | null;
    if (rawError) {
      let errorMsg: string;
      try {
        const parsed = JSON.parse(rawError) as { message?: string };
        errorMsg = parsed.message || rawError;
      } catch {
        errorMsg = rawError;
      }
      prompt += `\n\n## ⚠️ Previous Attempt Failed\nError: ${errorMsg}\nDo NOT repeat the same approach. Try a different strategy.\n`;
      logger.info('[GoalScheduler] Injected previous error into retry prompt', {
        executionId, retryCount, errorLength: errorMsg.length,
      });
    }
  }

  const strategy = getDispatchStrategy(ctx.recentFailures, ctx.recentTotal);
  const effectiveConcurrency = strategy === 'conservative' ? 2 : MAX_CONCURRENT;

  const dispatchStart = Date.now();
  logger.info('[GoalScheduler] Dispatching', {
    strategy,
    effectiveConcurrency,
    executionId,
    goalId: goal.id,
    stepIndex,
    taskType: input?.taskType || 'sub-agent',
    tier,
    hasRoleConstraints: roleConstraints.length > 0,
    hasSiblingContext: !!siblingContext,
    siblingContextSize: siblingContext?.length || 0,
    hasCompanyKnowledge: !!companyKnowledge,
    companyKnowledgeSize: companyKnowledge?.length || 0,
  });

  // Knowledge context injection — task-relevant search only (fast tier skips full DB knowledge)
  let knowledgeContext = '';

  // AS-019: task-relevant knowledge search (replaces generic getRecentContext)
  try {
    const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
    const searchLimit = 3;
    const searchResults = knowledgeBus.search(prompt || goal.title, { limit: searchLimit });
    if (searchResults.length > 0) {
      const searchContext = knowledgeBus.formatSearchForPrompt(searchResults);
      if (searchContext) knowledgeContext += searchContext;
    }
  } catch { /* best-effort */ }

  // Resolution KB 保留（安全网，不跳过）
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
        await workUnitService.transitionStatus(executionId, 'done');
        const newState = updateDispatchOutcome({ failures: ctx.recentFailures, total: ctx.recentTotal }, true);
        ctx.recentFailures = newState.failures;
        ctx.recentTotal = newState.total;
        logger.info('[GoalScheduler] Integration (code) succeeded', {
          goalId: goal.id, executionId, durationMs: Date.now() - dispatchStart,
        });
        return;
      }
      // B58: structured routing based on failure type
      const integrationResult = result as import('./integration-rollback.js').IntegrationResult;
      switch (integrationResult.failureType) {
        case 'merge_conflict':
        case 'unknown':
        case undefined:
          // Fall through to Claude Agent (existing behavior)
          logger.warn('[GoalScheduler] Integration failed, falling back to Claude', {
            goalId: goal.id, executionId, failureType: integrationResult.failureType,
          });
          break;
        case 'tsc_error':
        case 'test_failure': {
          const worktree = path.join(WORKTREES_DIR, executionId);
          const rollbackResult = await rollbackToIntegrationStep({
            goalId: goal.id,
            integrationExecutionId: executionId,
            failureType: integrationResult.failureType,
            error: integrationResult.error || 'unknown error',
            affectedFiles: integrationResult.affectedFiles || [],
            worktree,
          });
          if (rollbackResult.blocked) {
            logger.warn('[GoalScheduler] Rollback blocked, goal marked blocked', {
              goalId: goal.id, reason: rollbackResult.reason,
            });
            return;
          }
          logger.info('[GoalScheduler] Rollback complete, steps will be retried', {
            goalId: goal.id, rolledBackSteps: rollbackResult.rolledBackSteps,
          });
          return;
        }
        case 'missing_branch': {
          // Mark integration step as failed, don't retry
          await workUnitService.update(executionId, {
            metadata: { error: integrationResult.error || 'missing step branches' },
            failureType: 'not_retryable',
          });
          await workUnitService.transitionStatus(executionId, 'closed');
          return;
        }
      }
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
      model: 'fast',
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

    if (result.success) {
      await handleDispatchSuccess(executionId, goal, input, tier, strategy, result, dispatchStart, dispatchDuration, ctx);
    } else {
      await handleDispatchFailure(executionId, goal, input, tier, strategy, result, dispatchDuration, ctx);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const classification = classifyFailureAction(errorMsg);
    await workUnitService.update(executionId, {
      metadata: { error: errorMsg },
      failureType: classification.failureClass,
    });
    await workUnitService.transitionStatus(executionId, 'closed');
    logger.error('[GoalScheduler] Agent error', { executionId, error: errorMsg });
    // B57-P7: 统一告警 — Discord 通知 + 知识沉淀
    await onPhaseFailure({
      executionId,
      goalId: goal.id,
      phase: 'executing',
      error: errorMsg,
      severity: 'error',
    });
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

  const successMetadata: Record<string, any> = {};
  if (Object.keys(outputData).length > 0) successMetadata.output = JSON.stringify(outputData);
  if (Object.keys(successMetadata).length > 0) {
    await workUnitService.update(executionId, { metadata: successMetadata });
  }
  await workUnitService.transitionStatus(executionId, 'done');
  const tokenUsage = parseAgentTokenUsage(worktreeDir);
  // B59-004: read real test results from .progress.json
  let testPassed: boolean | undefined;
  try {
    const progressPath = path.join(worktreeDir, '.progress.json');
    if (fs.existsSync(progressPath)) {
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      const tr = progress.testResults;
      if (tr) testPassed = (tr.failed ?? 0) === 0 && (tr.passed ?? 0) > 0;
    }
  } catch { /* progress file may not exist or be invalid */ }
  recordPipelineRun({
    source: 'pipeline', phase: 'executor',
    taskName: goal.title,
    model: (tokenUsage.model && tokenUsage.model !== 'unknown') ? tokenUsage.model : (getModelForTier(tier as ModelTier) || 'default'),
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    cacheHitTokens: tokenUsage.cacheHitTokens,
    durationMs: result.totalDurationMs || dispatchDuration,
    success: true,
    sessionId: executionId,
    goalId: goal.id,
    ...(testPassed !== undefined ? { testPassed } : {}),
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
    const wuForTokens = await workUnitService.getById(goal.id);
    const metaForTokens = wuForTokens?.metadata ? JSON.parse(wuForTokens.metadata) : {};
    const prevTokens = (metaForTokens?._cumulativeTokens as number) || 0;
    const thisTokens = (tokenUsage.inputTokens || 0) + (tokenUsage.cacheHitTokens || 0);
    await workUnitService.update(goal.id, { metadata: { _cumulativeTokens: prevTokens + thisTokens } });
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
    const { getLastInjectedIds } = await import('../knowledge/consumers/prompt-builder.js');
    await knowledgeService.extractFromExecution({
      task: goal.title || executionId,
      diff: execOutput.slice(0, 5000),
      success: true,
      duration: result.totalDurationMs || dispatchDuration,
      agentType: 'executor',
      consumedKnowledge: getLastInjectedIds(),
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
 * 检查执行是否可以重试。retryCount < MAX_RETRIES → 重置为 unassigned，返回 true。
 * 已达上限 → 返回 false，由调用方走正常失败流程。
 */
export async function maybeRetryExecution(
  executionId: string,
  error: string,
  maxRetries: number = MAX_RETRIES,
): Promise<boolean> {
  // Not-retryable failures skip retry entirely
  const failureClass = classifyFailure(error);
  if (failureClass === 'not-retryable') {
    logger.info('[GoalScheduler] Failure not retryable, skipping retry', { executionId, failureClass });
    return false;
  }

  const wu = await workUnitService.getById(executionId);
  if (!wu) return false;

  const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
  const currentRetryCount = (wu.retryCount as number) || 0;

  if (currentRetryCount >= maxRetries) {
    logger.info('[GoalScheduler] Retry exhausted', { executionId, retryCount: currentRetryCount, maxRetries });
    return false;
  }

  await workUnitService.update(executionId, {
    retryCount: currentRetryCount + 1,
    completedAt: null,
    metadata: {
      ...meta,
      error: JSON.stringify({
        message: error,
        retryAttempt: currentRetryCount + 1,
        timestamp: Date.now(),
      }),
    },
  });
  // Reset to unassigned so scheduler picks it up again
  await prisma.workUnit.update({
    where: { id: executionId },
    data: { status: 'unassigned', claimedAt: null },
  });

  logger.warn('[GoalScheduler] Retrying execution', {
    executionId,
    retryCount: currentRetryCount + 1,
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
  // Retry check: if retryable, reset to unassigned and skip failure flow
  const errorStr = result.error || 'Agent execution failed';
  const retried = await maybeRetryExecution(executionId, errorStr);
  if (retried) return;

  const worktreeDir = path.join(WORKTREES_DIR, executionId);
  const classification = classifyFailureAction(errorStr);
  const wuStatus = classification.action === 'mark-blocked' ? 'blocked' : 'closed';
  const failureMetadata: Record<string, any> = { error: errorStr };
  if (result.failureLog) failureMetadata.output = JSON.stringify({ failureLog: result.failureLog });
  await workUnitService.update(executionId, {
    failureType: classification.failureClass,
    metadata: failureMetadata,
  });
  // blocked 状态通过 transitionStatus 设置；closed 也需要
  if (wuStatus === 'blocked') {
    await workUnitService.transitionStatus(executionId, 'blocked');
  } else {
    await workUnitService.transitionStatus(executionId, 'closed');
  }
  const failTokens = parseAgentTokenUsage(worktreeDir);
  // B59-004: read real test results from .progress.json (agent may have written before crash)
  let failTestPassed: boolean | undefined;
  try {
    const progressPath = path.join(worktreeDir, '.progress.json');
    if (fs.existsSync(progressPath)) {
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      const tr = progress.testResults;
      if (tr) failTestPassed = (tr.failed ?? 0) === 0 && (tr.passed ?? 0) > 0;
    }
  } catch { /* progress file may not exist */ }
  recordPipelineRun({
    source: 'pipeline', phase: 'executor',
    taskName: goal.title,
    model: (failTokens.model && failTokens.model !== 'unknown') ? failTokens.model : (typeof input === 'object' ? (input?.model as string) || 'standard' : 'standard'),
    inputTokens: failTokens.inputTokens,
    outputTokens: failTokens.outputTokens,
    cacheHitTokens: failTokens.cacheHitTokens,
    durationMs: result.totalDurationMs || dispatchDuration,
    success: false,
    error: result.error || 'Agent execution failed',
    sessionId: executionId,
    goalId: goal.id,
    ...(failTestPassed !== undefined ? { testPassed: failTestPassed } : {}),
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
