/**
 * Goal Review — 审查集成 + 成功处理 + 部署
 *
 * 从 goal.service.ts 提取。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { tracePipeline } from '../monitoring/trace-pipeline.service.js';
import { checkBeforeTaskComplete } from '@dommaker/studio-shared/harness/hooks';
import { reviewAgent } from '../agents/review-agent.service.js';
import { deployAgent } from '../agents/deploy-agent.service.js';
import { knowledgeAgent } from '../agents/knowledge-agent.service.js';
import { recordGoalCompletion, handleGoalFailed } from './goal-lifecycle.js';
import { parseJsonField, type GoalStep } from './goal-crud.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * 找审查 worktree：优先 integration step (stepIndex=999)，其次任一 succeeded step
 */
export async function findReviewWorktree(goalId: string): Promise<string | null> {
  const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

  const integrationExec = await prisma.goalExecution.findFirst({
    where: { goalId, stepIndex: 999, status: 'succeeded' },
    select: { id: true },
  });
  if (integrationExec) {
    const wt = path.join(WORKTREES_DIR, integrationExec.id);
    if (fs.existsSync(wt)) return wt;
  }

  const anyExec = await prisma.goalExecution.findFirst({
    where: { goalId, status: 'succeeded' },
    orderBy: { stepIndex: 'desc' },
    select: { id: true },
  });
  if (anyExec) {
    const wt = path.join(WORKTREES_DIR, anyExec.id);
    if (fs.existsSync(wt)) return wt;
  }

  return null;
}

/**
 * Goal 成功后：先审查，再决定放行还是打回
 */
export async function handleGoalSucceeded(goalId: string): Promise<void> {
  const goal = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!goal) return;

  const goalContext = (goal.context as unknown as Record<string, unknown>) || {};

  // 提取 ACs + D7: acGroup context
  const plan = await prisma.goalPlan.findFirst({
    where: { goalId, status: 'approved' },
    orderBy: { version: 'desc' },
  });
  let allAcs: string[] = [];
  let steps: GoalStep[] = [];
  const mergedContext: { files: string[]; gotchas: string[]; implementationNotes: string[] } = { files: [], gotchas: [], implementationNotes: [] };
  if (plan) {
    steps = (plan.steps as unknown as GoalStep[]) || [];
    allAcs = steps.flatMap(s => {
      const inp = s.input as Record<string, any> | null;
      const ag = inp?.acGroup;
      if (ag?.files) mergedContext.files.push(...ag.files);
      if (ag?.gotchas) mergedContext.gotchas.push(...ag.gotchas);
      if (ag?.implementationNotes) mergedContext.implementationNotes.push(ag.implementationNotes);
      return ag?.acs || [];
    });
  } else {
    const execs = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { input: true },
    });
    for (const e of execs) {
      const inp = parseJsonField<Record<string, any>>(e.input, {});
      const ag = inp?.acGroup;
      if (ag?.files) mergedContext.files.push(...ag.files);
      if (ag?.gotchas) mergedContext.gotchas.push(...ag.gotchas);
      if (ag?.implementationNotes) mergedContext.implementationNotes.push(ag.implementationNotes);
      allAcs.push(...(ag?.acs || []));
    }
  }
  const acGroupContext = mergedContext.files.length > 0 || mergedContext.gotchas.length > 0 ? {
    files: [...new Set(mergedContext.files)],
    gotchas: [...new Set(mergedContext.gotchas)],
    implementationNotes: mergedContext.implementationNotes.join('\n') || undefined,
  } : undefined;

  const worktree = await findReviewWorktree(goalId);
  if (!worktree) {
    logger.error('[Goal] No review worktree found — blocking goal for investigation', { goalId });
    await prisma.goal.update({
      where: { id: goalId },
      data: { status: 'blocked' },
    });
    try {
      const { triageAgent } = await import('../agents/triage-agent.service.js');
      await triageAgent.handleAlert({
        type: 'pipeline_health_degraded',
        severity: 'critical',
        message: `Goal ${goalId}: No review worktree found after all execution steps completed`,
        details: { goalId, reason: 'review_worktree_missing' },
      });
    } catch (triageErr) { logger.warn('[Goal] Triage escalation failed (non-blocking)', { error: String(triageErr) }); }
    return;
  }

  const reviewCycle = (goalContext.reviewCycle as number) || 0;
  const projectId = (goalContext.projectId as string) || goalId;

  const complexity: 'simple' | 'medium' | 'complex' =
    steps.length <= 1 && allAcs.length <= 3
      ? 'simple'
      : steps.length <= 3 && allAcs.length <= 10
        ? 'medium'
        : 'complex';

  logger.info('[Goal] Running Reviewer', { goalId, cycle: reviewCycle + 1, complexity });
  let review: { approved: boolean; score: number; issues: any[]; suggestions: string[] };
  try {
    review = await reviewAgent.reviewParallel({
      taskId: goalId,
      projectId,
      worktree,
      taskDescription: goal.title,
      acceptanceCriteria: allAcs.length > 0 ? allAcs : undefined,
      cycle: reviewCycle + 1,
      complexity,
      acGroupContext,
    });
  } catch (err) {
    logger.error('[Goal] Reviewer crashed — blocking deploy', { goalId, error: String(err) });
    await prisma.goal.update({ where: { id: goalId }, data: { status: 'blocked' } });
    const goalCtx = goal.context as unknown as Record<string, unknown> || {};
    const channelId = goalCtx.sourceChannelId as string;
    if (channelId) {
      try {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        await channelMessageService.createAgentMessage(channelId, 'System',
          `## 🚨 审查 Agent 崩溃\n\nGoal \`${goalId.slice(0, 8)}\` 的审查流程遇到异常。\n\n已阻断部署。请手动检查。`
        );
      } catch { /* best-effort */ }
    }
    return;
  }

  try {
    const issueSummary = review.issues?.length
      ? review.issues.slice(0, 5).map((i: any) => `[${i.severity}] ${i.message}`).join('; ')
      : 'no issues';
    tracePipeline.writeTrace('review', {
      executionId: goalId,
      goalId,
      agentType: 'reviewer',
      eventType: 'review.completed',
      timestamp: Date.now(),
      success: review.approved,
      summary: review.approved
        ? `Review PASSED (cycle ${reviewCycle + 1}, score ${review.score})`
        : `Review REJECTED (cycle ${reviewCycle + 1}, score ${review.score}, ${review.issues?.length || 0} issues): ${issueSummary}`,
      tokenUsage: null,
    });
  } catch {
    // best-effort
  }

  const blockingErrors = (review.issues || []).filter(
    (i: any) => i.severity === 'error'
  );
  const effectiveApproved = review.approved && blockingErrors.length === 0;
  if (blockingErrors.length > 0) {
    logger.warn('[Goal] Review approved but has blocking errors — overriding to rejected', {
      goalId,
      errorCount: blockingErrors.length,
      errors: blockingErrors.map((i: any) => i.message).slice(0, 5),
    });
  }

  if (effectiveApproved) {
    logger.info('[Goal] Review approved', { goalId, score: review.score, cycle: reviewCycle + 1 });
    await prisma.goal.update({
      where: { id: goalId },
      data: { context: { ...goalContext, reviewCycle: reviewCycle + 1, reviewScore: review.score } as any },
    });
    await finalizeGoalSucceeded(goalId);
  } else if (reviewCycle + 1 >= 3) {
    logger.warn('[Goal] Review max cycles exhausted, escalating', { goalId, cycles: reviewCycle + 1, score: review.score });
    await prisma.goal.update({
      where: { id: goalId },
      data: {
        status: 'blocked',
        context: { ...goalContext, reviewCycle: reviewCycle + 1, reviewScore: review.score } as any,
      },
    });
  } else {
    logger.info('[Goal] Review not approved, re-queuing for fixes', { goalId, cycle: reviewCycle + 1, score: review.score });
    await prisma.goal.update({
      where: { id: goalId },
      data: {
        status: 'executing',
        context: { ...goalContext, reviewCycle: reviewCycle + 1 } as any,
      },
    });

    const lastExec = await prisma.goalExecution.findFirst({
      where: { goalId, status: 'succeeded' },
      orderBy: { stepIndex: 'desc' },
    });
    if (lastExec) {
      await prisma.goalExecution.update({
        where: { id: lastExec.id },
        data: {
          status: 'pending',
          input: {
            ...((lastExec.input as unknown as Record<string, unknown>) || {}),
            taskType: 'review-fix',
            fixContext: review.issues.map(i => `[${i.severity}] ${i.message}`).join('\n'),
            reviewCycle: reviewCycle + 1,
          } as any,
        },
      });
    }
  }
}

/**
 * Goal 审查通过后：创建 PR + 更新 Project 状态 + 更新 OKR
 */
async function finalizeGoalSucceeded(goalId: string): Promise<void> {
  const goal = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!goal) return;

  const projectId = (goal.context as unknown as Record<string, unknown>)?.projectId as string | undefined;

  const goalExecutions = await prisma.goalExecution.findMany({
    where: { goalId },
    select: { id: true },
  });
  const executionIds = goalExecutions.map(e => e.id);

  const project = projectId
    ? await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, pmoNumber: true, gitBranch: true, gitRepo: true, status: true, okrId: true },
      })
    : null;

  // Test gate
  try {
    const worktree = await findReviewWorktree(goalId);
    if (worktree) {
      const progressPath = path.join(worktree, '.progress.json');
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        const testResults = progress.testResults || { passed: false, failed: 1, total: 0 };
        const evidenceText = testResults.evidence
          || (Array.isArray(testResults.keyEvidence) ? testResults.keyEvidence.join('; ') : undefined)
          || undefined;
        const { allowed, violations } = await checkBeforeTaskComplete([{
          passed: testResults.passed !== false && testResults.failed === 0,
          command: testResults.command || 'npm test',
          failures: [],
          evidence: evidenceText,
        }]);
        if (!allowed) {
          logger.warn('[Goal] Test gate blocked finalization', { goalId, violations });
          return;
        }
      }
    }
  } catch (e) {
    logger.error('[Goal] Test gate check failed — blocking deploy', { goalId, error: String(e) });
    await prisma.goal.update({ where: { id: goalId }, data: { status: 'blocked' } });
    throw new Error(`Test gate check failed: ${String(e)}`);
  }

  // PMO workflow
  if (project) {
    if (project.gitBranch) {
      logger.info(`[Goal] PR creation skipped (meeting module removed) for project ${project.pmoNumber}`);
    }

    if (project.status === 'active') {
      try {
        await prisma.project.update({
          where: { id: project.id },
          data: { status: 'in_review' },
        });
        logger.info(`[Goal] Project ${project.pmoNumber} → in_review`);
      } catch (e) {
        logger.warn('[Goal] Project update to in_review failed (non-blocking)', { projectId: project.id, error: String(e) });
      }
    }

    if (project.okrId) {
      try {
        const { okrService } = await import('../pmo/okr.service');
        await okrService.updateProgress(project.okrId);
        // syncKRProgress moved to PostEval (AS-018 UPDATE: pipeline completion triggers KR sync)
      } catch {
        logger.warn('[Goal] Failed to update OKR progress');
      }
    }
  } else {
    logger.info('[Goal] No project record — skipping PMO updates, proceeding to deploy', { goalId, projectId });
  }

  // Deploy
  try {
    const worktree = await findReviewWorktree(goalId);
    if (worktree) {
      const result = await deployAgent.deploy({
        projectId: projectId || goalId,
        executionId: goalId,
        executionIds,
        worktree,
        environment: 'vps',
        taskDescription: goal.title,
      });
      logger.info('[Goal] Deploy completed', {
        goalId,
        success: result.success,
        findings: result.findings.length,
      });

      if (result.success && project) {
        try {
          await prisma.project.update({
            where: { id: project.id },
            data: { status: 'completed' },
          });
          logger.info(`[Goal] Project ${project.pmoNumber} → completed`);
        } catch (e) {
          logger.warn('[Goal] Project update to completed failed (non-blocking)', { projectId: project.id, error: String(e) });
        }
      }

      knowledgeAgent.extractFromDeploy(result, goalId, projectId || goalId).catch(e => {
        logger.warn('[Goal] extractFromDeploy failed', { error: String(e) });
      });
    }
  } catch (e) {
    logger.warn('[Goal] Deploy check failed (non-blocking)', { error: String(e) });
  }

  await recordGoalCompletion(goalId);
}
