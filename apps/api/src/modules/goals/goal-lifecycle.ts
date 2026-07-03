/**
 * Goal Lifecycle — 状态转换（pending→executing→succeeded/failed）
 *
 * @deprecated Pipeline（Goal 系统）已废弃，由 Agent Network 替代。Phase 4 将删除整个 goals/ 目录。
 *
 * 从 goal.service.ts 提取。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger, appendChangelog, findSddDocByWorkUnitId } from '@dommaker/studio-shared';

import { skillStore } from '../skills/skill-store.js';
import { proposalStore } from '../skills/proposal-store.js';
import { tracePipeline } from '../monitoring/trace-pipeline.service.js';
import { checkBeforeTaskComplete } from '@dommaker/studio-shared/harness/hooks';
import { triageAgent } from '../agents/triage-agent.service.js';
import { classifyFailureAction, type FailureClass } from '../shared/failure-classifier.js';
import { AuditService } from '@dommaker/studio-audit';
import { recordExecution } from '../../daemon/metrics.js';
import { parseJsonField, type GoalStep } from './goal-crud.js';
import { handleGoalSucceeded, findReviewWorktree } from './goal-review.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

/**
 * 更新步骤执行状态
 */
export async function updateStepExecution(
  executionId: string,
  updates: { status?: string; output?: any; error?: string; input?: any; failureType?: FailureClass; timeoutAt?: Date },
  checkCompletionFn: (goalId: string) => Promise<void>,
): Promise<any> {
  const data: Record<string, any> = {};
  if (updates.output !== undefined) data.output = typeof updates.output === 'string' ? updates.output : JSON.stringify(updates.output);
  if (updates.input !== undefined) data.input = typeof updates.input === 'string' ? updates.input : JSON.stringify(updates.input);
  if (updates.error !== undefined) data.error = JSON.stringify({ message: updates.error, timestamp: Date.now() });
  if (updates.failureType !== undefined) data.failureType = updates.failureType;
  if (updates.timeoutAt !== undefined) data.timeoutAt = updates.timeoutAt;
  if (updates.status) data.status = updates.status;

  if (Object.keys(data).length > 0) {
    await prisma.goalExecution.update({ where: { id: executionId }, data });
  }

  if (updates.status === 'succeeded' || updates.status === 'failed') {
    const exec = await prisma.goalExecution.findUnique({ where: { id: executionId }, select: { goalId: true } });
    if (exec?.goalId) {
      await checkCompletionFn(exec.goalId);
    }
  }

  return executionId;
}

/**
 * 取消 WorkUnit — 用户中断正在运行的 Agent
 */
export async function cancelGoalExecution(
  executionId: string,
  checkCompletionFn: (goalId: string) => Promise<void>,
): Promise<any> {
  const exec = await prisma.goalExecution.findUnique({ where: { id: executionId } });
  if (!exec) throw new Error(`GoalExecution not found: ${executionId}`);
  if (exec.status !== 'running' && exec.status !== 'pending') {
    throw new Error(`Cannot cancel execution with status: ${exec.status}`);
  }

  const updated = await prisma.goalExecution.update({
    where: { id: executionId },
    data: {
      error: JSON.stringify({ message: '用户取消', cancelledAt: new Date().toISOString() }),
      status: 'failed',
    },
  });

  logger.info(`[Goal] Execution cancelled: ${executionId}`);
  if (exec.goalId) await checkCompletionFn(exec.goalId);
  return updated;
}

/**
 * 重试 WorkUnit — 重置失败的任务让 GoalScheduler 重新分派
 */
const MAX_RETRIES = 3;

export async function retryGoalExecution(executionId: string): Promise<any> {
  const exec = await prisma.goalExecution.findUnique({ where: { id: executionId } });
  if (!exec) throw new Error(`GoalExecution not found: ${executionId}`);
  if (exec.status !== 'failed') {
    throw new Error(`Can only retry failed executions, current: ${exec.status}`);
  }

  const goalId = exec.goalId;
  const retryCount = exec.retryCount || 0;
  if (retryCount >= MAX_RETRIES) {
    if (goalId) {
      await prisma.goal.update({
        where: { id: goalId },
        data: { status: 'blocked' },
      });
    }
    logger.warn(`[Goal] Execution ${executionId} exceeded max retries (${MAX_RETRIES}), goal ${goalId} marked blocked`);
    return {
      blocked: true,
      goalId,
      reason: `Execution retried ${retryCount} times with same error. Goal marked as blocked — requires manual investigation.`,
      lastError: exec.error,
    };
  }

  await prisma.goalExecution.update({
    where: { id: executionId },
    data: {
      retryCount: retryCount + 1,
      completedAt: null,
      error: null,
      status: 'pending',
    },
  });

  logger.info(`[Goal] Execution retried: ${executionId} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
  return { id: executionId, status: 'pending' };
}

/**
 * 检查目标是否完成
 */
/**
 * Cascade failure to unassigned steps whose dependencies have failed.
 * Uses 'blocked' status (retryable) instead of permanent 'failed'.
 * Returns true if any steps were cascaded.
 */
async function cascadeBlockedFailures(goalId: string, workUnits: any[]): Promise<boolean> {
  const stepIndexMap = new Map<number, any>();
  const acGroupIdMap = new Map<string, number>();
  for (const exec of workUnits) {
    const input = exec.input ? (typeof exec.input === 'string' ? JSON.parse(exec.input) : exec.input) : {};
    const stepIndex = exec.stepIndex ?? input?.stepIndex ?? 0;
    stepIndexMap.set(stepIndex, exec);
    const acGroupId = input?.acGroup?.id;
    if (acGroupId) acGroupIdMap.set(acGroupId, stepIndex);
  }

  const dependencyMap = new Map<number, number[]>();
  for (const exec of workUnits) {
    const input = exec.input ? (typeof exec.input === 'string' ? JSON.parse(exec.input) : exec.input) : {};
    const stepIndex = exec.stepIndex ?? input?.stepIndex ?? 0;
    const acGroup = input?.acGroup || {};
    const deps: number[] = (acGroup.dependencies || [])
      .map((depId: string) => acGroupIdMap.get(depId))
      .filter((i: number | undefined) => i !== undefined);
    dependencyMap.set(stepIndex, deps);
  }

  if (stepIndexMap.size === 0) return false;

  let cascaded = false;

  let changed = true;
  while (changed) {
    changed = false;
    for (const [stepIndex, exec] of stepIndexMap) {
      if (exec.status !== 'pending') continue;

      const deps = dependencyMap.get(stepIndex) || [];
      const blockedByFailedDep = deps.some((depIndex: number) => {
        const depExec = stepIndexMap.get(depIndex);
        return depExec?.status === 'failed' || depExec?.status === 'blocked';
      });

      if (blockedByFailedDep) {
        const failedDeps = deps.filter((d: number) => {
          const depExec = stepIndexMap.get(d);
          return depExec?.status === 'failed' || depExec?.status === 'blocked';
        });
        await prisma.goalExecution.update({
          where: { id: exec.id },
          data: {
            error: JSON.stringify({
              message: `Blocked by failed dependency (step ${failedDeps.join(', ')})`,
              timestamp: Date.now(),
            }),
            status: 'blocked',
          },
        });
        exec.status = 'blocked';
        cascaded = true;
        changed = true;
      }
    }
  }

  if (cascaded) {
    logger.warn('[Goal] Cascaded failure to blocked dependents', { goalId });
  }
  return cascaded;
}

/**
 * Reset blocked steps back to unassigned for retry.
 * Called when a previously failed step is retried.
 */
export async function resetBlockedByDependency(goalId: string): Promise<number> {
  const goalBlocked = await prisma.goalExecution.findMany({
    where: { goalId, status: 'blocked' },
  });

  if (goalBlocked.length === 0) return 0;

  for (const exec of goalBlocked) {
    await prisma.goalExecution.update({
      where: { id: exec.id },
      data: { status: 'pending' },
    });
  }

  logger.info(`[Goal] Reset ${goalBlocked.length} blocked steps to pending`, { goalId });
  return goalBlocked.length;
}

/**
 * Reset blocked steps whose dependencies are now all satisfied.
 * Called after a retry succeeds and dependencies change.
 */
async function resetUnblockedSteps(goalId: string, workUnits: any[]): Promise<boolean> {
  const blockedExecs = workUnits.filter(e => e.status === 'blocked');
  if (blockedExecs.length === 0) return false;

  const acGroupIdMap = new Map<string, number>();
  for (const exec of workUnits) {
    const input = exec.input ? (typeof exec.input === 'string' ? JSON.parse(exec.input) : exec.input) : {};
    const stepIndex = exec.stepIndex ?? input?.stepIndex ?? 0;
    const acGroupId = input?.acGroup?.id;
    if (acGroupId) acGroupIdMap.set(acGroupId, stepIndex);
  }

  const stepIndexMap = new Map(workUnits.map((exec: any) => {
    const input = exec.input ? (typeof exec.input === 'string' ? JSON.parse(exec.input) : exec.input) : {};
    return [exec.stepIndex ?? input?.stepIndex ?? 0, exec];
  }));

  let resetCount = 0;

  for (const exec of blockedExecs) {
    const input = exec.input ? (typeof exec.input === 'string' ? JSON.parse(exec.input) : exec.input) : {};
    const stepIndex = exec.stepIndex ?? input?.stepIndex ?? 0;
    const acGroup = input?.acGroup || {};
    const deps: number[] = (acGroup.dependencies || [])
      .map((depId: string) => acGroupIdMap.get(depId))
      .filter((i: number | undefined) => i !== undefined);

    const allDepsSatisfied = deps.every((depIndex: number) => {
      const depExec = stepIndexMap.get(depIndex);
      return depExec?.status === 'succeeded';
    });

    if (allDepsSatisfied) {
      await prisma.goalExecution.update({
        where: { id: exec.id },
        data: { status: 'pending' },
      });
      exec.status = 'pending';
      resetCount++;
    }
  }

  if (resetCount > 0) {
    logger.info(`[Goal] Reset ${resetCount} unblocked steps to pending`, { goalId });
  }
  return resetCount > 0;
}

export async function checkGoalCompletion(goalId: string): Promise<void> {
  let executions = await prisma.goalExecution.findMany({ where: { goalId } });

  if (executions.length === 0) {
    logger.warn('[Goal] No executions found, marking failed', { goalId });
    await prisma.goal.update({
      where: { id: goalId }, data: { status: 'failed', completedAt: new Date() },
    });
    return;
  }

  const cascaded = await cascadeBlockedFailures(goalId, executions);
  if (cascaded) {
    executions = await prisma.goalExecution.findMany({ where: { goalId } });
  }

  const unblocked = await resetUnblockedSteps(goalId, executions);
  if (unblocked) {
    executions = await prisma.goalExecution.findMany({ where: { goalId } });
  }

  const isIntegrationStep = (exec: any) => {
    const input = exec.input ? (typeof exec.input === 'string' ? JSON.parse(exec.input) : exec.input) : {};
    return exec.stepIndex === 999 || input?.taskType === 'integration' || input?.stepIndex === 999;
  };

  const regularSteps = executions.filter(e => !isIntegrationStep(e));
  const integrationStep = executions.find(e => isIntegrationStep(e));
  const allTerminal = ['succeeded', 'failed', 'blocked'];
  const allRegularDone = regularSteps.every(e => allTerminal.includes(e.status));

  if (allRegularDone && !integrationStep && regularSteps.length > 1) {
    const anyRegularFailed = regularSteps.some(e => e.status === 'failed' || e.status === 'blocked');
    if (!anyRegularFailed) {
      logger.info('[Goal] All sub-agent steps succeeded, creating integration step', { goalId });
      try {
        await prisma.goalExecution.create({
          data: {
            goalId,
            stepIndex: 999,
            status: 'pending',
            agentType: 'integration',
            input: JSON.stringify({
              taskType: 'integration',
              goalId,
              totalSteps: regularSteps.length,
              stepIndex: 999,
              model: 'standard',
            }),
          },
        });
        logger.info('[Goal] Integration step created, waiting for scheduler', { goalId });
      } catch (err) {
        logger.error('[Goal] Failed to create integration step', { goalId, error: String(err) });
        await prisma.goal.update({
          where: { id: goalId }, data: { status: 'failed', completedAt: new Date() },
        });
      }
      return;
    }
  }

  const allDone = executions.every(e => allTerminal.includes(e.status));
  if (!allDone) return;

  const anyFailed = executions.some(e => e.status === 'failed' || e.status === 'blocked');
  const goalStatus = anyFailed ? 'failed' : 'succeeded';

  await prisma.goal.update({
    where: { id: goalId },
    data: {
      status: goalStatus,
      completedAt: new Date(),
    },
  });

  const newStatus = goalStatus;
  logger.info(`[Goal] ${goalId} completed with status: ${newStatus}`);

  // SP-004 Step 6: CHANGELOG entry for goal completion
  try {
    const slug = findSddDocByWorkUnitId(goalId);
    if (slug) {
      appendChangelog(slug, `Goal ${newStatus} (${goalId.slice(0, 8)})`);
    }
  } catch { /* non-blocking */ }

  try {
    const { appendFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const eventsDir = process.env.EVENTS_DIR || join(homedir(), 'events');
    const { mkdirSync } = await import('fs');
    mkdirSync(eventsDir, { recursive: true });
    appendFileSync(
      join(eventsDir, 'studio.jsonl'),
      JSON.stringify({
        type: newStatus === 'succeeded' ? 'goal:completed' : 'goal:failed',
        goalId,
        status: newStatus,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  } catch { /* non-blocking */ }

  if (newStatus === 'succeeded') {
    createGoalDocument(goalId).catch(err =>
      logger.warn('[Goal] Document creation failed (non-blocking)', { goalId, error: String(err) })
    );
  }

  tracePipeline.analyzeAfterGoalComplete(goalId).then(async result => {
    if (result && result.anomalies.length > 0) {
      const alerts = await tracePipeline.getAlerts(result);
      for (const alert of alerts) {
        logger.warn(`[TracePipeline] ${alert.level}: ${alert.message}`, { goalId });
      }
    }
  }).catch(err => {
    logger.warn('[TracePipeline] Analysis failed (non-blocking)', { goalId, error: String(err) });
  });

  trackSkillOutcomes(goalId, newStatus).catch(err => {
    logger.warn('[SkillOutcome] Tracking failed (non-blocking)', { goalId, error: String(err) });
  });

  if (newStatus === 'succeeded') {
    await handleGoalSucceeded(goalId);
  } else {
    await handleGoalFailed(goalId);
  }

  // Cleanup executor worktrees and task branches (non-blocking)
  // Only on final success — after review approves (not during review-fix cycles)
  // Defer cleanup: re-check goal status after handleGoalSucceeded may have dispatched review-fix
  if (newStatus === 'succeeded') {
    const currentGoal = await prisma.goal.findUnique({ where: { id: goalId }, select: { status: true } });
    if (currentGoal?.status === 'succeeded') {
      cleanupGoalWorktrees(goalId).catch(err =>
        logger.warn('[Goal] Worktree cleanup failed (non-blocking)', { goalId, error: String(err) })
      );
    } else {
      logger.info('[Goal] Skipping worktree cleanup — review cycle pending', { goalId, currentStatus: currentGoal?.status });
    }
  }
}

/**
 * 清理 Goal 关联的所有 executor worktree 和 task 分支
 */
async function cleanupGoalWorktrees(goalId: string): Promise<void> {
  const executions = await prisma.goalExecution.findMany({
    where: { goalId },
    select: { id: true },
  });
  const worktreesDir = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
  const repoDir = process.env.REPO_DIR || path.join(os.homedir(), 'projects', 'studio');

  for (const exec of executions) {
    const worktreePath = path.join(worktreesDir, exec.id);
    // Remove worktree directory
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* may not exist */ }
    // Remove worktree registration
    try { execSync(`git worktree remove "${worktreePath}" --force 2>/dev/null`, { cwd: repoDir, timeout: 10_000, stdio: 'pipe' }); } catch { /* may not be registered */ }
    // Delete task branches matching this execution ID
    try {
      const branches = execSync(`git branch --list "task/*${exec.id}*" 2>/dev/null`, { cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }).trim();
      for (const branch of branches.split('\n').filter(Boolean)) {
        const name = branch.replace(/^[*+ ]+/, '');
        if (name) execSync(`git branch -D "${name}"`, { cwd: repoDir, timeout: 5_000, stdio: 'pipe' });
      }
    } catch { /* may not exist */ }
  }

  logger.info('[Goal] Worktree cleanup done', { goalId, cleaned: executions.length });
}

/**
 * Goal 失败后：更新 Project 状态为 failed
 */
export async function handleGoalFailed(goalId: string): Promise<void> {
  const goal = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!goal) return;

  const goalMeta = goal.context ? (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) : {};
  const goalContext = goalMeta || {};
  const projectId = goalContext?.projectId as string | undefined;
  const goalTitle = goal.title;

  const allGoalExecs = await prisma.goalExecution.findMany({ where: { goalId } });
  const failedExecs = allGoalExecs
    .filter(e => e.status === 'failed')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const failedExec = failedExecs[0];
  const errorRaw: any = failedExec?.error;
  const errorMsg = typeof errorRaw === 'object' ? (errorRaw?.message || JSON.stringify(errorRaw)) : (String(errorRaw || 'Unknown failure'));

  // Query FailureEvent to determine incident type (race-condition safe: fallback to 'zombie')
  let incidentType: string = 'zombie';
  let incidentSeverity: 'critical' | 'warning' = 'warning';
  try {
    const latestFailure = await prisma.failureEvent.findFirst({
      where: { goalId },
      orderBy: { createdAt: 'desc' },
    });
    if (latestFailure?.routeTarget === 'triage' && latestFailure.incidentType) {
      incidentType = latestFailure.incidentType;
      incidentSeverity = latestFailure.severity === 'critical' ? 'critical' : 'warning';
    }
  } catch { /* fallback to 'zombie' */ }

  // Deterministic failure routing — prefer persisted failureType, fallback to classifyFailureAction
  let action: string;
  let failureClass: string;
  if (failedExec?.failureType) {
    // Use already-classified failureType from execution
    failureClass = failedExec.failureType;
    if (failureClass === 'infrastructure' || failureClass === 'retryable') {
      action = 'retry-execution';
    } else if (failureClass === 'not-retryable') {
      action = 'mark-blocked';
    } else {
      action = 'triage-agent';
    }
  } else {
    // Fallback: classify from error message and persist
    const result = classifyFailureAction(errorMsg);
    action = result.action;
    failureClass = result.failureClass;
    // B.1: Persist failureType if not already set
    if (failedExec && failureClass && failureClass !== 'unknown') {
      try {
        await prisma.goalExecution.update({
          where: { id: failedExec.id },
          data: { failureType: failureClass },
        });
      } catch { /* non-blocking */ }
    }
  }
  let routed = false;

  if (action === 'retry-execution' && failedExec) {
    logger.info(`[Goal] Failure classified as ${failureClass}, auto-retrying execution`, { goalId, executionId: failedExec.id });
    try {
      await retryGoalExecution(failedExec.id);
      await prisma.goal.update({
        where: { id: goalId },
        data: { status: 'executing', completedAt: null },
      });
      routed = true;
    } catch (e) {
      logger.warn('[Goal] Auto-retry failed, falling back to triage', { goalId, error: String(e) });
    }
  }

  if (!routed && action === 'triage-agent') {
    try {
      await triageAgent.handleAlert({
        type: incidentType as any,
        severity: incidentSeverity,
        message: `Goal ${goalId.slice(0, 8)} failed: ${errorMsg.slice(0, 200)}`,
        details: { goalId, executionId: failedExec?.id, projectId },
      });
      logger.info('[Goal] TriageAgent alerted for goal failure', { goalId });
    } catch (e) {
      logger.warn('[Goal] TriageAgent alert failed (non-blocking)', { error: String(e) });
    }
  }
  // mark-blocked: skip triageAgent, notification below is sufficient

  try {
    const sourceChannelId = goalContext?.sourceChannelId as string | undefined;
    if (sourceChannelId) {
      const failReason = failedExec?.error ? String(failedExec.error).slice(0, 200) : '未知原因';
      const { channelMessageService } = await import('../channels/channel-message.service.js');
      await channelMessageService.createAgentMessage(sourceChannelId, 'Executor', [
        `## ❌ Goal 失败: ${goalTitle}`,
        '',
        `**原因**: ${failReason}`,
        `**建议**: 拆分任务为更小的 AC 组，或使用 premium tier 模型`,
        `**重试**: @Analyst 小步重构，将大任务拆为独立 Goal`,
      ].join('\n'), { meta: { goalId, cardType: 'goal_failed' } });
    }
  } catch (e) {
    logger.warn('[Goal] Failed to send failure notification', { goalId, error: String(e) });
  }

  if (!projectId) return;

  try {
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'failed' },
    });
    logger.info(`[Goal] Project ${projectId} → failed`);
  } catch (e: any) {
    logger.warn('[Goal] Project update failed (non-blocking)', { projectId, error: String(e) });
  }
}

/**
 * 记录 Goal 完成指标、审计日志、生成总结
 */
export async function recordGoalCompletion(goalId: string): Promise<void> {
  try {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return;

    const goalTitle = goal.title;
    const goalMeta = goal.context ? (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) : {};
    const goalStatus = goal.status === 'succeeded' ? 'succeeded' : goal.status === 'failed' ? 'failed' : goal.status;

    const executions = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { id: true, startedAt: true, completedAt: true, status: true },
    });
    const execIds = executions.map(e => e.id);

    // Match by goalId (preferred) or sessionId (fallback for older records)
    const runs = await prisma.pipelineRun.findMany({
      where: {
        OR: [
          { goalId },
          { sessionId: { in: execIds } },
        ],
      },
    });

    const totalInputTokens = runs.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutputTokens = runs.reduce((s, r) => s + r.outputTokens, 0);
    const totalSessions = runs.length;
    const successCount = runs.filter(r => r.success).length;

    // Duration: prefer PipelineRun sum, fallback to WorkUnit wall clock
    let totalDurationMs = runs.reduce((s, r) => s + r.durationMs, 0);
    if (totalDurationMs === 0 && executions.length > 0) {
      const starts = executions.filter(e => e.startedAt).map(e => e.startedAt!.getTime());
      const ends = executions.filter(e => e.completedAt).map(e => e.completedAt!.getTime());
      if (starts.length > 0 && ends.length > 0) {
        totalDurationMs = Math.max(...ends) - Math.min(...starts);
      }
    }

    // B59-004: derive testPassed from child runs' real test results (not session success rate)
    const stepRuns = runs.filter(r => r.phase !== 'full');
    const runsWithTestResult = stepRuns.filter(r => r.testPassed !== null && r.testPassed !== undefined);
    const summaryTestPassed = runsWithTestResult.length > 0
      ? runsWithTestResult.every(r => r.testPassed === true)
      : undefined;

    const written = await recordExecution({
      source: 'execution', phase: 'full',
      taskName: goalTitle,
      model: 'summary',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheHitTokens: runs.reduce((s, r) => s + r.cacheHitTokens, 0),
      durationMs: totalDurationMs,
      success: goalStatus === 'succeeded',
      ...(summaryTestPassed !== undefined ? { testPassed: summaryTestPassed } : {}),
      goalId,
    });

    if (!written) {
      logger.error('[GoalLifecycle] CRITICAL: PipelineRun summary write failed', { goalId, totalSessions, totalInputTokens });
    }

    // Health check: verify at least one PipelineRun exists for this goal
    if (totalSessions === 0) {
      logger.warn('[GoalLifecycle] No PipelineRun records found for goal — metrics gap', {
        goalId, execIds: execIds.length, goalStatus,
      });
      try {
        await prisma.studioEvent.create({
          data: {
            type: 'pipeline:metrics_missing',
            source: 'goal-lifecycle',
            payload: JSON.stringify({ goalId, execCount: execIds.length, goalStatus }),
          },
        });
      } catch { /* last resort */ }
    }

    try {
      const auditService = new AuditService(prisma);
      await auditService.log({
        action: 'goal_completed',
        resource: 'goal',
        resourceId: goalId,
        details: {
          title: goalTitle,
          status: goalStatus,
          totalInputTokens,
          totalOutputTokens,
          totalDurationMs,
          totalSessions,
          successCount,
        },
        status: 'success',
      });
    } catch { /* non-blocking */ }

    logger.info('[Goal] Pipeline summary recorded', {
      goalId,
      title: goalTitle,
      sessions: totalSessions,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      durationMs: totalDurationMs,
    });

    // ── Knowledge feedback loop: recordOutcome at goal completion ──
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      await knowledgeService.recordOutcome({
        executionId: goalId,
        agentType: 'executor',
        consumedKnowledge: [],
        success: goalStatus === 'succeeded',
        details: `Goal "${goalTitle}" ${goalStatus}. Sessions: ${totalSessions}, Tokens: ${totalInputTokens + totalOutputTokens}`,
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
      });
    } catch { /* non-blocking */ }

    try {
      const goalContextForSummary = goalMeta;
      const sourceChannelId = goalContextForSummary?.sourceChannelId as string | undefined;
      if (sourceChannelId) {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        const durationMin = Math.round(totalDurationMs / 60000);
        const tokenK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
        const summary = [
          `## Goal 完成: ${goalTitle}`,
          `- 状态: ${goalStatus === 'succeeded' ? '✅ 成功' : goalStatus === 'failed' ? '❌ 失败' : '⏳ ' + goalStatus}`,
          `- Session: ${totalSessions} 轮`,
          `- Token: ${tokenK(totalInputTokens)} → ${tokenK(totalOutputTokens)}`,
          `- 耗时: ${durationMin} min`,
          `- 执行步: ${successCount}/${totalSessions} 成功`,
        ].join('\n');
        await channelMessageService.createAgentMessage(sourceChannelId, 'Executor', summary, {
          meta: { goalId, cardType: 'goal_summary' },
        });
      }
    } catch (e) {
      logger.warn('[Goal] Failed to send summary card', { goalId, error: String(e) });
    }

    try {
      const goalContextForPostEval = goalMeta;
      const sourceChannelId = goalContextForPostEval?.sourceChannelId as string | undefined;
      const { postEvalAgent } = await import('../agents/post-eval-agent.service.js');
      const gapReport = await postEvalAgent.evaluate(goalId, sourceChannelId);

      // PostEval remediation: completeness < 50% → flag goal as incomplete
      if (gapReport && gapReport.completeness < 0.5 && goalStatus === 'succeeded') {
        logger.error('[Goal] PostEval: completeness critically low — flagging goal', {
          goalId,
          completeness: Math.round(gapReport.completeness * 100) + '%',
          matched: gapReport.matchedAcs.length,
          missed: gapReport.missedAcs.length,
        });
        await prisma.goal.update({
          where: { id: goalId },
          data: { status: 'failed', completedAt: new Date() },
        });
        if (sourceChannelId) {
          try {
            const { channelMessageService } = await import('../channels/channel-message.service.js');
            await channelMessageService.createAgentMessage(sourceChannelId, 'System',
              `## ⚠️ PostEval 检测到完成度不足\n\nGoal \`${goalId.slice(0, 8)}\` 完成度 ${Math.round(gapReport.completeness * 100)}%，已标记为失败。\n\n缺失 AC: ${gapReport.missedAcs.slice(0, 5).join(', ')}`
            );
          } catch { /* best-effort */ }
        }
      }
    } catch (e) {
      logger.warn('[Goal] PostEval failed', { goalId, error: String(e) });
    }

    // Signal Aggregator: 聚合原始 signal → 趋势摘要
    try {
      const { signalAggregator } = await import('../knowledge/signal-aggregator.js');
      const trendsCreated = await signalAggregator.run();
      if (trendsCreated > 0) {
        logger.info('[Goal] Signal trends aggregated', { goalId, trendsCreated });
      }
    } catch (e) {
      logger.warn('[Goal] SignalAggregator failed (non-blocking)', { goalId, error: String(e) });
    }
  } catch (e) {
    logger.error('[Goal] CRITICAL: Failed to record completion metrics', { goalId, error: String(e) });
    try {
      await prisma.studioEvent.create({
        data: {
          type: 'pipeline:metrics_write_failed',
          source: 'goal-lifecycle',
          payload: JSON.stringify({ goalId, error: String(e) }),
        },
      });
    } catch { /* last resort */ }
  }
}

/**
 * SPEC-1: Goal 完成时自动生成 execution Document
 */
async function createGoalDocument(goalId: string): Promise<void> {
  try {
    const goal = await prisma.goal.findUnique({
      where: { id: goalId },
      select: { id: true, title: true, context: true },
    });
    if (!goal) return;
    const goalMeta = goal.context ? (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) : {};
    const goalContext = goalMeta || {};
    const companyId = goalContext?.companyId as string | undefined;
    if (!companyId) return;

    const goalTitle = goal.title;

    const project = await prisma.project.findFirst({
      where: { companyId },
      select: { id: true },
    });
    if (!project) return;

    const execs = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { id: true, stepIndex: true, output: true, status: true },
      take: 10,
    });

    const summary = execs.map(exec => {
      const statusLabel = exec.status;
      const output = exec.output;
      let outputSummary = 'no summary';
      if (output) {
        try {
          const parsed = typeof output === 'string' ? JSON.parse(output) : output;
          outputSummary = parsed?.summary || JSON.stringify(parsed).slice(0, 100);
        } catch { outputSummary = String(output).slice(0, 100); }
      }
      return `- Step ${exec.stepIndex}: ${statusLabel} (${outputSummary})`;
    }).join('\n');

    await prisma.document.create({
      data: {
        projectId: project.id,
        companyId,
        type: 'execution',
        title: goalTitle || `Goal ${goalId.slice(0, 8)}`,
        content: `## Execution Summary\n\nGoal: ${goalTitle}\nID: ${goalId}\n\n### Steps\n${summary}`,
        status: 'active',
        tags: '[]',
      },
    });

    logger.info(`[Goal] Document created for ${goalId.slice(0, 8)}`);
  } catch (err) {
    logger.warn('[Goal] Document creation failed', { goalId, error: String(err) });
  }
}

/**
 * ⑯: Skill outcome tracking — 记录 Goal 中使用的 Skill 的 Review 结果
 */
async function trackSkillOutcomes(goalId: string, goalStatus: string): Promise<void> {
  try {
    const proposals = proposalStore.list({
      status: { in: ['approved', 'pending'] },
    });

    const related = proposals.filter(p => {
      try {
        const skill = skillStore.get(p.skillId);
        if (!skill) return false;
        const meta = skill.metadata ? JSON.parse(skill.metadata) : {};
        const goalIds: string[] = meta?.sourceGoalIds || [];
        return goalIds.includes(goalId);
      } catch { return false; }
    });

    if (related.length === 0) return;

    const outcome = goalStatus === 'succeeded' ? 'passed' : 'failed';
    for (const p of related) {
      const skill = skillStore.get(p.skillId);
      if (!skill) continue;

      const currentMeta = skill.metadata ? JSON.parse(skill.metadata) : {};
      const reviewHistory = [...(currentMeta.reviewOutcomes || []), { goalId, outcome, at: new Date().toISOString() }];
      skillStore.update(p.skillId, {
        metadata: JSON.stringify({ ...currentMeta, reviewOutcomes: reviewHistory.slice(-20) }),
      });
    }

    logger.info(`[SkillOutcome] Tracked ${related.length} skills for goal ${goalId} (${outcome})`);
  } catch (err) {
    logger.warn('[SkillOutcome] Failed', { goalId, error: String(err) });
  }
}

/**
 * Validate worktree paths for active WorkUnits on startup.
 * If a worktree directory is missing (e.g. after server restart with cleaned /tmp),
 * mark the WorkUnit as closed with a clear ENOENT-specific message.
 */
export async function validateWorktreePaths(): Promise<number> {
  const runningExecs = await prisma.goalExecution.findMany({
    where: { status: 'running' },
  });

  if (runningExecs.length === 0) return 0;

  const worktreesDir = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
  let failedCount = 0;

  for (const exec of runningExecs) {
    const worktreePath = path.join(worktreesDir, exec.id);
    if (!fs.existsSync(worktreePath)) {
      await prisma.goalExecution.update({
        where: { id: exec.id },
        data: {
          error: JSON.stringify({
            message: `Worktree directory missing after restart: ${worktreePath}`,
            timestamp: Date.now(),
          }),
          status: 'failed',
        },
      });
      logger.warn(`[Goal] Worktree lost for execution ${exec.id}, marked failed`);
      failedCount++;
    }
  }

  if (failedCount > 0) {
    logger.warn(`[Goal] validateWorktreePaths: ${failedCount}/${runningExecs.length} executions had missing worktrees`);
  }
  return failedCount;
}

/**
 * Auto-fail WorkUnits that have been in 'blocked' status for > 7 days.
 * Called periodically by GoalScheduler tick and on server startup.
 */
const BLOCKED_GOAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function expireStaleBlockedGoals(): Promise<number> {
  const cutoff = new Date(Date.now() - BLOCKED_GOAL_TTL_MS);

  const stale = await prisma.goalExecution.findMany({
    where: { status: 'blocked', createdAt: { lt: cutoff } },
    select: { id: true, createdAt: true, goalId: true },
  });

  if (stale.length === 0) return 0;

  for (const exec of stale) {
    const ageDays = Math.round((Date.now() - exec.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    await prisma.goalExecution.update({
      where: { id: exec.id },
      data: {
        error: JSON.stringify({
          message: `auto-fail: blocked > 7 days TTL (age: ${ageDays}d)`,
          timestamp: Date.now(),
        }),
        status: 'failed',
      },
    });
    logger.warn('[Goal] Auto-failed stale blocked execution (TTL)', {
      executionId: exec.id,
      goalId: exec.goalId,
      ageDays,
    });
  }

  logger.info(`[Goal] expireStaleBlockedGoals: ${stale.length} executions auto-failed`);
  return stale.length;
}
