/**
 * Goal Lifecycle — 状态转换（pending→executing→succeeded/failed）
 *
 * 从 goal.service.ts 提取。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger, appendChangelog, findSddDocByGoalId } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { EXECUTION_TO_WORKUNIT_STATUS, GOAL_TO_WORKUNIT_STATUS, mapExecutionStatuses, isTerminalStatus } from '../workunit/status-mapping.js';
import { skillStore } from '../skills/skill-store.js';
import { proposalStore } from '../skills/proposal-store.js';
import { tracePipeline } from '../monitoring/trace-pipeline.service.js';
import { checkBeforeTaskComplete } from '@dommaker/studio-shared/harness/hooks';
import { triageAgent } from '../agents/triage-agent.service.js';
import { classifyFailureAction, type FailureClass } from './failure-classifier.js';
import { AuditService } from '@dommaker/studio-audit';
import { recordExecution } from '../../daemon/metrics.js';
import { parseJsonField, type GoalStep } from './goal-crud.js';
import { handleGoalSucceeded, findReviewWorktree } from './goal-review.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

const workUnitService = new WorkUnitService(prisma);

/**
 * 更新步骤执行状态
 */
export async function updateStepExecution(
  executionId: string,
  updates: { status?: string; output?: any; error?: string; input?: any; failureType?: FailureClass; timeoutAt?: Date },
  checkCompletionFn: (goalId: string) => Promise<void>,
): Promise<any> {
  // Build metadata updates for fields that moved to JSON
  const metadataUpdates: Record<string, any> = {};
  if (updates.output !== undefined) metadataUpdates.output = updates.output;
  if (updates.input !== undefined) metadataUpdates.input = updates.input;
  if (updates.error !== undefined) {
    metadataUpdates.error = JSON.stringify({ message: updates.error, timestamp: Date.now() });
  }

  const wuUpdate: Record<string, any> = {};
  if (Object.keys(metadataUpdates).length > 0) wuUpdate.metadata = metadataUpdates;
  if (updates.failureType !== undefined) wuUpdate.failureType = updates.failureType;
  if (updates.timeoutAt !== undefined) wuUpdate.timeoutAt = updates.timeoutAt;

  if (Object.keys(wuUpdate).length > 0) {
    await workUnitService.update(executionId, wuUpdate);
  }

  // Status transition
  if (updates.status) {
    const wuStatus = EXECUTION_TO_WORKUNIT_STATUS[updates.status];
    if (wuStatus) {
      await workUnitService.transitionStatus(executionId, wuStatus);
    }
  }

  // Trigger completion check for terminal states
  if (updates.status === 'succeeded' || updates.status === 'failed') {
    const wu = await workUnitService.getById(executionId);
    const meta = wu?.metadata ? JSON.parse(wu.metadata) : {};
    const goalId = meta?.goalId;
    if (goalId) {
      await checkCompletionFn(goalId);
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
  const wu = await workUnitService.getById(executionId);
  if (!wu) throw new Error(`WorkUnit not found: ${executionId}`);
  if (wu.status !== 'active' && wu.status !== 'unassigned') {
    throw new Error(`Cannot cancel work unit with status: ${wu.status}`);
  }

  await workUnitService.update(executionId, {
    metadata: { error: JSON.stringify({ message: '用户取消', cancelledAt: new Date().toISOString() }) },
  });
  const updated = await workUnitService.transitionStatus(executionId, 'closed');

  const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
  const goalId = meta?.goalId;
  logger.info(`[Goal] Execution cancelled: ${executionId}`);
  if (goalId) await checkCompletionFn(goalId);
  return updated;
}

/**
 * 重试 WorkUnit — 重置失败的任务让 GoalScheduler 重新分派
 */
const MAX_RETRIES = 3;

export async function retryGoalExecution(executionId: string): Promise<any> {
  const wu = await workUnitService.getById(executionId);
  if (!wu) throw new Error(`WorkUnit not found: ${executionId}`);
  if (wu.status !== 'closed') {
    throw new Error(`Can only retry closed work units, current: ${wu.status}`);
  }

  const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
  const goalId = meta?.goalId;
  const retryCount = (wu.retryCount as number) || 0;
  if (retryCount >= MAX_RETRIES) {
    // Mark goal as blocked — repeated failures indicate a systematic issue
    if (goalId) {
      await prisma.workUnit.update({
        where: { id: goalId },
        data: { status: 'blocked' },
      });
    }
    logger.warn(`[Goal] Execution ${executionId} exceeded max retries (${MAX_RETRIES}), goal ${goalId} marked blocked`);
    return {
      blocked: true,
      goalId,
      reason: `Execution retried ${retryCount} times with same error. Goal marked as blocked — requires manual investigation.`,
      lastError: meta?.error,
    };
  }

  // Reset to unassigned for retry
  await workUnitService.update(executionId, {
    retryCount: retryCount + 1,
    completedAt: null,
    metadata: { ...meta, _retryCount: retryCount + 1, error: null },
  });
  await workUnitService.transitionStatus(executionId, 'unassigned');

  logger.info(`[Goal] Execution retried: ${executionId} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
  return { id: executionId, status: 'unassigned' };
}

/**
 * 检查目标是否完成
 */
/**
 * Cascade failure to unassigned steps whose dependencies have failed.
 * Uses 'blocked' status (retryable) instead of permanent 'closed'.
 * Returns true if any steps were cascaded.
 */
async function cascadeBlockedFailures(goalId: string, workUnits: any[]): Promise<boolean> {
  // Build lookup maps: stepIndex → WorkUnit, acGroupId → stepIndex
  const stepIndexMap = new Map<number, any>();
  const acGroupIdMap = new Map<string, number>();
  for (const wu of workUnits) {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
    const stepIndex = input?.stepIndex ?? wu.retryCount; // fallback
    stepIndexMap.set(stepIndex, wu);
    const acGroupId = input?.acGroup?.id;
    if (acGroupId) acGroupIdMap.set(acGroupId, stepIndex);
  }

  // Build dependency edges from dependsOn or metadata
  const dependencyMap = new Map<number, number[]>(); // stepIndex → dependency stepIndices
  for (const wu of workUnits) {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
    const stepIndex = input?.stepIndex ?? 0;
    const acGroup = input?.acGroup || {};
    const deps: number[] = (acGroup.dependencies || [])
      .map((depId: string) => acGroupIdMap.get(depId))
      .filter((i: number | undefined) => i !== undefined);
    dependencyMap.set(stepIndex, deps);
  }

  if (stepIndexMap.size === 0) return false;

  let cascaded = false;

  // Iteratively cascade: a step is blocked if any dependency is closed/blocked
  let changed = true;
  while (changed) {
    changed = false;
    for (const [stepIndex, wu] of stepIndexMap) {
      if (wu.status !== 'unassigned') continue;

      const deps = dependencyMap.get(stepIndex) || [];
      const blockedByFailedDep = deps.some((depIndex: number) => {
        const depWu = stepIndexMap.get(depIndex);
        return depWu?.status === 'closed' || depWu?.status === 'blocked';
      });

      if (blockedByFailedDep) {
        const failedDeps = deps.filter((d: number) => {
          const depWu = stepIndexMap.get(d);
          return depWu?.status === 'closed' || depWu?.status === 'blocked';
        });
        await workUnitService.update(wu.id, {
          metadata: {
            error: JSON.stringify({
              message: `Blocked by failed dependency (step ${failedDeps.join(', ')})`,
              timestamp: Date.now(),
            }),
          },
        });
        await workUnitService.transitionStatus(wu.id, 'blocked');
        wu.status = 'blocked'; // update local map for chain cascading
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
  const blocked = await prisma.workUnit.findMany({
    where: { status: 'blocked', metadata: { contains: goalId } },
  });

  // Filter to only WorkUnits belonging to this goal
  const goalBlocked = blocked.filter(wu => {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    return meta?.goalId === goalId;
  });

  if (goalBlocked.length === 0) return 0;

  for (const wu of goalBlocked) {
    await workUnitService.transitionStatus(wu.id, 'unassigned');
  }

  logger.info(`[Goal] Reset ${goalBlocked.length} blocked steps to unassigned`, { goalId });
  return goalBlocked.length;
}

/**
 * Reset blocked steps whose dependencies are now all satisfied.
 * Called after a retry succeeds and dependencies change.
 */
async function resetUnblockedSteps(goalId: string, workUnits: any[]): Promise<boolean> {
  const blockedWus = workUnits.filter(wu => wu.status === 'blocked');
  if (blockedWus.length === 0) return false;

  // Build lookup maps
  const acGroupIdMap = new Map<string, number>();
  for (const wu of workUnits) {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
    const stepIndex = input?.stepIndex ?? 0;
    const acGroupId = input?.acGroup?.id;
    if (acGroupId) acGroupIdMap.set(acGroupId, stepIndex);
  }

  const stepIndexMap = new Map(workUnits.map((wu: any) => {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
    return [input?.stepIndex ?? 0, wu];
  }));

  let resetCount = 0;

  for (const wu of blockedWus) {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
    const stepIndex = input?.stepIndex ?? 0;
    const acGroup = input?.acGroup || {};
    const deps: number[] = (acGroup.dependencies || [])
      .map((depId: string) => acGroupIdMap.get(depId))
      .filter((i: number | undefined) => i !== undefined);

    const allDepsSatisfied = deps.every((depIndex: number) => {
      const depWu = stepIndexMap.get(depIndex);
      return depWu?.status === 'done';
    });

    if (allDepsSatisfied) {
      await workUnitService.transitionStatus(wu.id, 'unassigned');
      wu.status = 'unassigned'; // update local map
      resetCount++;
    }
  }

  if (resetCount > 0) {
    logger.info(`[Goal] Reset ${resetCount} unblocked steps to unassigned`, { goalId });
  }
  return resetCount > 0;
}

export async function checkGoalCompletion(goalId: string): Promise<void> {
  // Fetch all WorkUnits belonging to this goal
  let allWus = await prisma.workUnit.findMany({
    where: { metadata: { contains: goalId } },
  });
  // Filter to only WorkUnits with matching goalId in metadata
  let workUnits = allWus.filter(wu => {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    return meta?.goalId === goalId;
  });

  if (workUnits.length === 0) {
    logger.warn('[Goal] No work units found, marking failed', { goalId });
    await prisma.workUnit.update({
      where: { id: goalId }, data: { status: 'closed', completedAt: new Date() },
    });
    return;
  }

  // Cascade failure to steps blocked by failed dependencies
  const cascaded = await cascadeBlockedFailures(goalId, workUnits);
  if (cascaded) {
    // Re-fetch with updated statuses
    allWus = await prisma.workUnit.findMany({ where: { metadata: { contains: goalId } } });
    workUnits = allWus.filter(wu => {
      const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
      return meta?.goalId === goalId;
    });
  }

  // Reset blocked steps whose dependencies are now satisfied
  const unblocked = await resetUnblockedSteps(goalId, workUnits);
  if (unblocked) {
    allWus = await prisma.workUnit.findMany({ where: { metadata: { contains: goalId } } });
    workUnits = allWus.filter(wu => {
      const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
      return meta?.goalId === goalId;
    });
  }

  const isIntegrationStep = (wu: any) => {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
    return input?.stepIndex === 999 || input?.taskType === 'integration';
  };

  const regularSteps = workUnits.filter(wu => !isIntegrationStep(wu));
  const integrationStep = workUnits.find(wu => isIntegrationStep(wu));
  const terminalStatuses = mapExecutionStatuses(['succeeded', 'failed']); // ['done', 'closed'] plus 'blocked'
  const allTerminal = [...terminalStatuses, 'blocked'];
  const allRegularDone = regularSteps.every(wu => allTerminal.includes(wu.status));

  if (allRegularDone && !integrationStep && regularSteps.length > 1) {
    const anyRegularFailed = regularSteps.some(wu => wu.status === 'closed' || wu.status === 'blocked');
    if (!anyRegularFailed) {
      logger.info('[Goal] All sub-agent steps succeeded, creating integration step', { goalId });
      try {
        await workUnitService.create({
          scope: `integration-${goalId}`,
          status: 'unassigned',
          metadata: {
            goalId,
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
        await prisma.workUnit.update({
          where: { id: goalId }, data: { status: 'closed', completedAt: new Date() },
        });
      }
      return;
    }
  }

  const allDone = workUnits.every(wu => allTerminal.includes(wu.status));
  if (!allDone) return;

  const anyFailed = workUnits.some(wu => wu.status === 'closed' || wu.status === 'blocked');
  const goalWuStatus = anyFailed ? 'closed' : 'done';

  await prisma.workUnit.update({
    where: { id: goalId },
    data: {
      status: goalWuStatus,
      completedAt: new Date(),
    },
  });

  const newStatus = anyFailed ? 'failed' : 'succeeded';
  logger.info(`[Goal] ${goalId} completed with status: ${newStatus}`);

  // SP-004 Step 6: CHANGELOG entry for goal completion
  try {
    const slug = findSddDocByGoalId(goalId);
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
    const currentGoalWu = await prisma.workUnit.findUnique({ where: { id: goalId }, select: { status: true } });
    if (currentGoalWu?.status === 'done') {
      cleanupGoalWorktrees(goalId).catch(err =>
        logger.warn('[Goal] Worktree cleanup failed (non-blocking)', { goalId, error: String(err) })
      );
    } else {
      logger.info('[Goal] Skipping worktree cleanup — review cycle pending', { goalId, currentStatus: currentGoalWu?.status });
    }
  }
}

/**
 * 清理 Goal 关联的所有 executor worktree 和 task 分支
 */
async function cleanupGoalWorktrees(goalId: string): Promise<void> {
  const allWus = await prisma.workUnit.findMany({
    where: { metadata: { contains: goalId } },
    select: { id: true, metadata: true },
  });
  const executions = allWus.filter(wu => {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    return meta?.goalId === goalId;
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
  const goalWu = await prisma.workUnit.findUnique({ where: { id: goalId } });
  if (!goalWu) return;

  const goalMeta = goalWu.metadata ? JSON.parse(goalWu.metadata) : {};
  const goalContext = goalMeta?.context ? (typeof goalMeta.context === 'string' ? JSON.parse(goalMeta.context) : goalMeta.context) : {};
  const projectId = goalContext?.projectId as string | undefined;
  const goalTitle = goalMeta?.title || goalWu.scope;

  // Find the most recently failed WorkUnit for this goal
  const allGoalWus = await prisma.workUnit.findMany({
    where: { metadata: { contains: goalId } },
  });
  const failedWus = allGoalWus.filter(wu => {
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    return meta?.goalId === goalId && wu.status === 'closed';
  }).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const failedExec = failedWus[0];
  const failedMeta = failedExec?.metadata ? JSON.parse(failedExec.metadata) : {};
  const errorRaw: any = failedMeta?.error;
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
        await workUnitService.update(failedExec.id, { failureType: failureClass });
      } catch { /* non-blocking */ }
    }
  }
  let routed = false;

  if (action === 'retry-execution' && failedExec) {
    logger.info(`[Goal] Failure classified as ${failureClass}, auto-retrying execution`, { goalId, executionId: failedExec.id });
    try {
      await retryGoalExecution(failedExec.id);
      // Reset goal status so GoalScheduler picks up the retried execution
      await workUnitService.transitionStatus(goalId, 'unassigned');
      await workUnitService.update(goalId, { completedAt: null });
      await workUnitService.transitionStatus(goalId, 'active');
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
      const failReason = failedMeta?.error ? String(failedMeta.error).slice(0, 200) : '未知原因';
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
    const goalWu = await prisma.workUnit.findUnique({ where: { id: goalId } });
    if (!goalWu) return;

    const goalMeta = goalWu.metadata ? JSON.parse(goalWu.metadata) : {};
    const goalTitle = goalMeta?.title || goalWu.scope;
    const goalStatus = goalWu.status === 'done' ? 'succeeded' : goalWu.status === 'closed' ? 'failed' : goalWu.status;

    // Find all step-level WorkUnits for this goal
    const allGoalWus = await prisma.workUnit.findMany({
      where: { metadata: { contains: goalId } },
      select: { id: true, claimedAt: true, completedAt: true, status: true, metadata: true },
    });
    const executions = allGoalWus.filter(wu => {
      const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
      return meta?.goalId === goalId;
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
      // Fallback: wall clock from earliest claim to latest completion
      const starts = executions.filter(e => e.claimedAt).map(e => e.claimedAt!.getTime());
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
      const goalContextForSummary = goalMeta?.context ? (typeof goalMeta.context === 'string' ? JSON.parse(goalMeta.context) : goalMeta.context) : {};
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
      const goalContextForPostEval = goalMeta?.context ? (typeof goalMeta.context === 'string' ? JSON.parse(goalMeta.context) : goalMeta.context) : {};
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
        // Roll back status so the goal can be retried
        await prisma.workUnit.update({
          where: { id: goalId },
          data: { status: 'closed', completedAt: new Date() },
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
    const goalWu = await prisma.workUnit.findUnique({
      where: { id: goalId },
      select: { id: true, scope: true, metadata: true },
    });
    if (!goalWu) return;
    const goalMeta = goalWu.metadata ? JSON.parse(goalWu.metadata) : {};
    const goalContext = goalMeta?.context ? (typeof goalMeta.context === 'string' ? JSON.parse(goalMeta.context) : goalMeta.context) : {};
    const companyId = goalContext?.companyId as string | undefined;
    if (!companyId) return;

    const goalTitle = goalMeta?.title || goalWu.scope;

    const project = await prisma.project.findFirst({
      where: { companyId },
      select: { id: true },
    });
    if (!project) return;

    const allGoalWus = await prisma.workUnit.findMany({
      where: { metadata: { contains: goalId } },
      select: { id: true, metadata: true, status: true },
      take: 10,
    });
    const execs = allGoalWus.filter(wu => {
      const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
      return meta?.goalId === goalId;
    });

    const summary = execs.map(wu => {
      const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
      const input = meta?.input ? (typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input) : {};
      const stepIndex = input?.stepIndex ?? '?';
      const output = meta?.output;
      const statusLabel = wu.status === 'done' ? 'succeeded' : wu.status === 'closed' ? 'failed' : wu.status;
      return `- Step ${stepIndex}: ${statusLabel} (${(output as any)?.summary || 'no summary'})`;
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
  const activeWus = await prisma.workUnit.findMany({
    where: { status: 'active' },
  });

  if (activeWus.length === 0) return 0;

  const worktreesDir = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
  let failedCount = 0;

  for (const wu of activeWus) {
    const worktreePath = path.join(worktreesDir, wu.id);
    if (!fs.existsSync(worktreePath)) {
      await workUnitService.update(wu.id, {
        metadata: {
          error: JSON.stringify({
            message: `Worktree directory missing after restart: ${worktreePath}`,
            timestamp: Date.now(),
          }),
        },
      });
      await workUnitService.transitionStatus(wu.id, 'closed');
      logger.warn(`[Goal] Worktree lost for WorkUnit ${wu.id}, marked closed`);
      failedCount++;
    }
  }

  if (failedCount > 0) {
    logger.warn(`[Goal] validateWorktreePaths: ${failedCount}/${activeWus.length} work units had missing worktrees`);
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

  const stale = await prisma.workUnit.findMany({
    where: { status: 'blocked', createdAt: { lt: cutoff } },
    select: { id: true, scope: true, createdAt: true, metadata: true },
  });

  if (stale.length === 0) return 0;

  for (const wu of stale) {
    const ageDays = Math.round((Date.now() - wu.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
    await workUnitService.update(wu.id, {
      metadata: {
        ...meta,
        failureReason: `auto-fail: blocked > 7 days TTL (age: ${ageDays}d)`,
        autoFailedAt: new Date().toISOString(),
      },
    });
    await workUnitService.transitionStatus(wu.id, 'closed');
    logger.warn('[Goal] Auto-failed stale blocked WorkUnit (TTL)', {
      workUnitId: wu.id,
      scope: wu.scope?.slice(0, 60),
      ageDays,
    });
  }

  logger.info(`[Goal] expireStaleBlockedGoals: ${stale.length} work units auto-failed`);
  return stale.length;
}
