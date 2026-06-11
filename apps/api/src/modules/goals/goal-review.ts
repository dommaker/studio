/**
 * Goal Review — 审查集成 + 成功处理 + 部署
 *
 * 从 goal.service.ts 提取。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { tracePipeline } from '../monitoring/trace-pipeline.service.js';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
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

  const allErrors = (review.issues || []).filter(
    (i: any) => i.severity === 'error'
  );

  // 区分 diff 中的 error（blocking）vs 已有代码的 error（discoveredIssues）
  let diffBlockingErrors: typeof allErrors = allErrors;
  let discoveredIssues: typeof allErrors = [];

  if (allErrors.length > 0 && worktree) {
    try {
      const baseRef = process.env.REVIEW_BASE_REF || 'HEAD~1';
      const { stdout: changedFilesRaw } = await execSh(
        `git diff ${baseRef} --name-only 2>/dev/null || git diff --name-only 2>/dev/null || echo ""`,
        { cwd: worktree, timeoutMs: 10_000 },
      );
      const changedFiles = new Set(
        changedFilesRaw.split('\n').map(f => f.trim()).filter(Boolean)
      );

      if (changedFiles.size > 0) {
        diffBlockingErrors = allErrors.filter(
          (i: any) => !i.file || changedFiles.has(i.file)
        );
        discoveredIssues = allErrors.filter(
          (i: any) => i.file && !changedFiles.has(i.file)
        );
      }
    } catch {
      // git diff 失败 → 保守处理：全部当 blocking
    }
  }

  // Score gate: approved but score too low → override to rejected
  const MIN_REVIEW_SCORE = 50;
  const scoreTooLow = review.approved && review.score < MIN_REVIEW_SCORE;
  const effectiveApproved = review.approved && !scoreTooLow && diffBlockingErrors.length === 0;

  if (scoreTooLow) {
    logger.warn('[Goal] Review: score too low — overriding to rejected', {
      goalId, score: review.score, minScore: MIN_REVIEW_SCORE,
    });
  }

  if (diffBlockingErrors.length > 0) {
    logger.warn('[Goal] Review: diff has blocking errors — overriding to rejected', {
      goalId,
      errorCount: diffBlockingErrors.length,
      errors: diffBlockingErrors.map((i: any) => i.message).slice(0, 5),
    });
  }

  // 方案 4: discoveredIssues → KnowledgeStore + Channel 通知（不阻断 merge）
  if (discoveredIssues.length > 0) {
    logger.info('[Goal] Review discovered pre-existing issues (non-blocking)', {
      goalId,
      count: discoveredIssues.length,
      files: discoveredIssues.map((i: any) => i.file).filter(Boolean),
    });

    // 写入 KnowledgeStore 供 KnowledgeKeeper 后续消费
    for (const issue of discoveredIssues) {
      try {
        await knowledgeBus.recordPattern({
          type: 'pitfall',
          title: `Review 发现已有代码问题: ${issue.file || 'unknown'}`,
          content: [
            `source_goal: ${goalId}`,
            `file: ${issue.file || 'unknown'}`,
            `severity: ${issue.severity}`,
            `issue: ${issue.message}`,
            `root_cause: review 期间发现的已有代码问题，非本次变更引入`,
            `fix_action: 创建 tech_debt goal 修复`,
          ].join('\n'),
          severity: 'warning',
          timestamp: Date.now(),
          source: 'reviewer',
          context: { goalId, file: issue.file, discoveredDuringReview: true },
        });
      } catch (kbErr) {
        logger.warn('[Goal] Failed to write discoveredIssue to KnowledgeStore (non-blocking)', { error: String(kbErr) });
      }
    }

    // 通知 source channel
    const goalCtx = goal.context as unknown as Record<string, unknown> || {};
    const channelId = goalCtx.sourceChannelId as string;
    if (channelId) {
      try {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        const issueList = discoveredIssues
          .map((i: any) => `- **${i.file || 'unknown'}**: ${i.message}`)
          .join('\n');
        await channelMessageService.createAgentMessage(channelId, 'System',
          `## 审查发现已有代码问题（non-blocking）\n\n${issueList}\n\n已记录到知识库，不阻断本次 merge。`,
        );
      } catch { /* best-effort */ }
    }
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
  let deploySuccess = true;
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

      deploySuccess = result.success;

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
    deploySuccess = false;
    logger.warn('[Goal] Deploy check failed', { error: String(e) });
  }

  // Deploy failure → roll back goal status
  if (!deploySuccess) {
    logger.warn('[Goal] Deploy failed — rolling back goal status to failed', { goalId });
    await prisma.goal.update({
      where: { id: goalId },
      data: { status: 'failed', completedAt: new Date() },
    });
    return;
  }

  await recordGoalCompletion(goalId);
}
