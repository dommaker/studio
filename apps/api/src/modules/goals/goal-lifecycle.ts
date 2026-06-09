/**
 * Goal Lifecycle — 状态转换（pending→executing→succeeded/failed）
 *
 * 从 goal.service.ts 提取。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { tracePipeline } from '../monitoring/trace-pipeline.service.js';
import { checkBeforeTaskComplete } from '@dommaker/studio-shared/harness/hooks';
import { triageAgent } from '../agents/triage-agent.service.js';
import { AuditService } from '@dommaker/studio-audit';
import { recordPipelineRun } from '../../daemon/metrics.js';
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
  updates: { status?: string; output?: any; error?: string; input?: any },
  checkCompletionFn: (goalId: string) => Promise<void>,
): Promise<any> {
  const data: Record<string, any> = { ...updates };
  if (updates.error !== undefined) {
    data.error = JSON.stringify({ message: updates.error, timestamp: Date.now() });
  }
  const execution = await prisma.goalExecution.update({
    where: { id: executionId },
    data: {
      ...data,
      ...(updates.status === 'running' ? { startedAt: new Date() } : {}),
      ...(updates.status === 'succeeded' || updates.status === 'failed'
        ? { completedAt: new Date() }
        : {}),
    },
  });

  if (updates.status === 'succeeded' || updates.status === 'failed') {
    await checkCompletionFn(execution.goalId);
  }

  return execution;
}

/**
 * 取消 GoalExecution — 用户中断正在运行的 Agent
 */
export async function cancelGoalExecution(
  executionId: string,
  checkCompletionFn: (goalId: string) => Promise<void>,
): Promise<any> {
  const execution = await prisma.goalExecution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error(`GoalExecution not found: ${executionId}`);
  if (execution.status !== 'running' && execution.status !== 'pending') {
    throw new Error(`Cannot cancel execution with status: ${execution.status}`);
  }

  const updated = await prisma.goalExecution.update({
    where: { id: executionId },
    data: {
      status: 'failed',
      error: JSON.stringify({ message: '用户取消', cancelledAt: new Date().toISOString() }),
      completedAt: new Date(),
    },
  });

  logger.info(`[Goal] Execution cancelled: ${executionId}`);
  await checkCompletionFn(execution.goalId);
  return updated;
}

/**
 * 重试 GoalExecution — 重置失败的任务让 GoalScheduler 重新分派
 */
const MAX_RETRIES = 3;

export async function retryGoalExecution(executionId: string): Promise<any> {
  const execution = await prisma.goalExecution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error(`GoalExecution not found: ${executionId}`);
  if (execution.status !== 'failed') {
    throw new Error(`Can only retry failed executions, current: ${execution.status}`);
  }

  // Check retry count from input metadata
  const input = (typeof execution.input === 'string' ? JSON.parse(execution.input) : execution.input) as Record<string, any> || {};
  const retryCount = input._retryCount || 0;
  if (retryCount >= MAX_RETRIES) {
    // Mark goal as blocked — repeated failures indicate a systematic issue
    await prisma.goal.update({
      where: { id: execution.goalId },
      data: { status: 'blocked' },
    });
    logger.warn(`[Goal] Execution ${executionId} exceeded max retries (${MAX_RETRIES}), goal ${execution.goalId} marked blocked`);
    return {
      blocked: true,
      goalId: execution.goalId,
      reason: `Execution retried ${retryCount} times with same error. Goal marked as blocked — requires manual investigation.`,
      lastError: execution.error,
    };
  }

  const updated = await prisma.goalExecution.update({
    where: { id: executionId },
    data: {
      status: 'pending',
      error: null,
      completedAt: null,
      startedAt: null,
      input: JSON.stringify({ ...input, _retryCount: retryCount + 1 }),
    },
  });

  logger.info(`[Goal] Execution retried: ${executionId} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
  return updated;
}

/**
 * 检查目标是否完成
 */
export async function checkGoalCompletion(goalId: string): Promise<void> {
  const executions = await prisma.goalExecution.findMany({
    where: { goalId },
  });

  if (executions.length === 0) {
    logger.warn('[Goal] No executions found, marking failed', { goalId });
    await prisma.goal.update({
      where: { id: goalId }, data: { status: 'failed', completedAt: new Date() },
    });
    return;
  }

  const regularSteps = executions.filter(e => e.stepIndex !== 999);
  const integrationStep = executions.find(e => e.stepIndex === 999);
  const allRegularDone = regularSteps.every(e => e.status === 'succeeded' || e.status === 'failed');

  if (allRegularDone && !integrationStep && regularSteps.length > 1) {
    const anyRegularFailed = regularSteps.some(e => e.status === 'failed');
    if (!anyRegularFailed) {
      logger.info('[Goal] All sub-agent steps succeeded, creating integration step', { goalId });
      try {
        await prisma.goalExecution.create({
          data: {
            goalId,
            stepIndex: 999,
            status: 'pending',
            agentType: 'claude',
            input: JSON.stringify({
              taskType: 'integration',
              goalId,
              totalSteps: regularSteps.length,
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

  const allDone = executions.every(e => e.status === 'succeeded' || e.status === 'failed');
  if (!allDone) return;

  const anyFailed = executions.some(e => e.status === 'failed');
  const newStatus = anyFailed ? 'failed' : 'succeeded';

  await prisma.goal.update({
    where: { id: goalId },
    data: {
      status: newStatus,
      completedAt: new Date(),
    },
  });

  logger.info(`[Goal] ${goalId} completed with status: ${newStatus}`);

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

  const projectId = (goal.context as unknown as Record<string, unknown>)?.projectId as string | undefined;

  const failedExec = await prisma.goalExecution.findFirst({
    where: { goalId, status: 'failed' },
    select: { id: true, error: true, stepIndex: true },
    orderBy: { stepIndex: 'desc' },
  });
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

  try {
    const ctx = (goal.context as unknown as Record<string, unknown>) || {};
    const sourceChannelId = ctx.sourceChannelId as string | undefined;
    if (sourceChannelId) {
      const failReason = failedExec?.error ? failedExec.error.slice(0, 200) : '未知原因';
      const { channelMessageService } = await import('../channels/channel-message.service.js');
      await channelMessageService.createAgentMessage(sourceChannelId, 'Executor', [
        `## ❌ Goal 失败: ${goal.title}`,
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

    // Find all step-level PipelineRun records for this goal
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

    // Duration: prefer PipelineRun sum, fallback to GoalExecution wall clock
    let totalDurationMs = runs.reduce((s, r) => s + r.durationMs, 0);
    if (totalDurationMs === 0 && executions.length > 0) {
      // Fallback: wall clock from earliest start to latest completion
      const starts = executions.filter(e => e.startedAt).map(e => e.startedAt!.getTime());
      const ends = executions.filter(e => e.completedAt).map(e => e.completedAt!.getTime());
      if (starts.length > 0 && ends.length > 0) {
        totalDurationMs = Math.max(...ends) - Math.min(...starts);
      }
    }

    const written = await recordPipelineRun({
      source: 'pipeline', phase: 'full',
      taskName: goal.title,
      model: 'summary',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheHitTokens: runs.reduce((s, r) => s + r.cacheHitTokens, 0),
      durationMs: totalDurationMs,
      success: goal.status === 'succeeded',
      testPassed: successCount === totalSessions,
      goalId: goal.id,
    });

    if (!written) {
      logger.error('[GoalLifecycle] CRITICAL: PipelineRun summary write failed', { goalId, totalSessions, totalInputTokens });
    }

    // Health check: verify at least one PipelineRun exists for this goal
    if (totalSessions === 0) {
      logger.warn('[GoalLifecycle] No PipelineRun records found for goal — metrics gap', {
        goalId, execIds: execIds.length, goalStatus: goal.status,
      });
      try {
        await prisma.studioEvent.create({
          data: {
            type: 'pipeline:metrics_missing',
            source: 'goal-lifecycle',
            payload: JSON.stringify({ goalId, execCount: execIds.length, goalStatus: goal.status }),
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
          title: goal.title,
          status: goal.status,
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
      title: goal.title,
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
        success: goal.status === 'succeeded',
        details: `Goal "${goal.title}" ${goal.status}. Sessions: ${totalSessions}, Tokens: ${totalInputTokens + totalOutputTokens}`,
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
      });
    } catch { /* non-blocking */ }

    try {
      const ctx = (goal.context as unknown as Record<string, unknown>) || {};
      const sourceChannelId = ctx.sourceChannelId as string | undefined;
      if (sourceChannelId) {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        const durationMin = Math.round(totalDurationMs / 60000);
        const tokenK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
        const summary = [
          `## Goal 完成: ${goal.title}`,
          `- 状态: ${goal.status === 'succeeded' ? '✅ 成功' : goal.status === 'failed' ? '❌ 失败' : '⏳ ' + goal.status}`,
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
      const ctx2 = (goal.context as unknown as Record<string, unknown>) || {};
      const sourceChannelId = ctx2.sourceChannelId as string | undefined;
      const { postEvalAgent } = await import('../agents/post-eval-agent.service.js');
      await postEvalAgent.evaluate(goalId, sourceChannelId);
    } catch (e) {
      logger.warn('[Goal] PostEval failed', { goalId, error: String(e) });
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
      select: { id: true, title: true, companyId: true },
    });
    if (!goal?.companyId) return;

    const project = await prisma.project.findFirst({
      where: { companyId: goal.companyId },
      select: { id: true },
    });
    if (!project) return;

    const execs = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { id: true, output: true, stepIndex: true, status: true },
      take: 10,
    });

    const summary = execs.map(e =>
      `- Step ${e.stepIndex}: ${e.status} (${(e.output as any)?.summary || 'no summary'})`
    ).join('\n');

    await prisma.document.create({
      data: {
        projectId: project.id,
        companyId: goal.companyId,
        type: 'execution',
        title: goal.title || `Goal ${goalId.slice(0, 8)}`,
        content: `## Execution Summary\n\nGoal: ${goal.title}\nID: ${goalId}\n\n### Steps\n${summary}`,
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
    const proposals = await prisma.skillProposal.findMany({
      where: {
        status: { in: ['approved', 'pending'] },
      },
      include: { skill: true },
    });

    const related = proposals.filter(p => {
      try {
        const meta = p.skill?.metadata as any;
        const goalIds: string[] = meta?.sourceGoalIds || [];
        return goalIds.includes(goalId);
      } catch { return false; }
    });

    if (related.length === 0) return;

    const outcome = goalStatus === 'succeeded' ? 'passed' : 'failed';
    for (const p of related) {
      await prisma.skillProposal.update({
        where: { id: p.id },
        data: {
          metadata: {
            ...((p.skill?.metadata as any) || {}),
            lastReviewOutcome: outcome,
            lastReviewGoalId: goalId,
            lastReviewAt: new Date().toISOString(),
          },
        } as any,
      });

      if (p.skill) {
        const currentMeta = (p.skill.metadata as any) || {};
        const reviewHistory = [...(currentMeta.reviewOutcomes || []), { goalId, outcome, at: new Date().toISOString() }];
        await prisma.skill.update({
          where: { id: p.skill.id },
          data: {
            metadata: { ...currentMeta, reviewOutcomes: reviewHistory.slice(-20) },
            status: currentMeta.status || p.skill.status,
          } as any,
        });
      }
    }

    logger.info(`[SkillOutcome] Tracked ${related.length} skills for goal ${goalId} (${outcome})`);
  } catch (err) {
    logger.warn('[SkillOutcome] Failed', { goalId, error: String(err) });
  }
}
