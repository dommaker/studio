/**
 * Review Orchestrator — 审查循环管理
 *
 * 从 agent-event-listener.ts 提取。
 */
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { discordNotifier } from '../../utils/discord-notifier.js';
import { reviewAgent } from '../agents/review-agent.service.js';
import { roleConfigService } from '../roles/role-config.service.js';
import { knowledgeAgent } from '../agents/knowledge-agent.service.js';
import { recordDecision } from '@dommaker/studio-shared/harness/hooks';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import { recordReviewRejected } from '../harness/evolution.service.js';
import type { ReviewReport } from '../agents/review-report.js';

export const MAX_REVIEW_CYCLES = 3;

/**
 * 读取 worktree 中的审查报告 cycle 数
 */
export function readReviewCycle(worktree: string): number {
  try {
    const reportPath = path.join(worktree, '.review-report.json');
    if (!fs.existsSync(reportPath)) return 0;

    const raw = fs.readFileSync(reportPath, 'utf-8');
    const report: ReviewReport = JSON.parse(raw);
    return report.cycle || 0;
  } catch {
    return 0;
  }
}

/**
 * 审查循环耗尽时通知人工介入
 */
export async function notifyEscalation(taskId: string, projectId: string): Promise<void> {
  try {
    await discordNotifier.sendText(
      '🔴 审查循环耗尽 - 需要人工介入',
      `任务 ${taskId}（项目 ${projectId}）经过 ${MAX_REVIEW_CYCLES} 轮审查仍未通过，需要人工介入。`
    );
  } catch (e) {
    logger.error('[AgentEventListener] Failed to send escalation notification', { error: String(e) });
  }
}

/**
 * 审查循环耗尽时的处理：更新状态 + 记录 pitfall + 审计
 */
async function handleReviewExhausted(
  taskId: string,
  task: { projectId: string; description: string | null; name: string },
  goalExecutionId: string,
  goalId: string | undefined,
  worktree: string,
  cycle: number,
  review: { score: number; issues: Array<{ severity: string; message: string }> },
  goalExec: { goalId: string },
): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'blocked',
      description: (task.description || task.name) +
        `\n\n[Review #${cycle}] Score: ${review.score}\nIssues: ${review.issues.map(i => i.message).join('; ')}` +
        `\n\n⚠️ 已达最大审查循环次数，需要人工介入。`,
    },
  });
  await notifyEscalation(taskId, task.projectId);

  // 审计: 审查循环耗尽
  recordDecision({
    eventType: 'review.exhausted',
    entityType: 'review',
    entityId: taskId,
    projectId: task.projectId,
    summary: `审查耗尽（${cycle}/${MAX_REVIEW_CYCLES} 轮未通过，score: ${review.score}）: ${task.name}`,
    details: { cycle, score: review.score, issues: review.issues.slice(0, 5).map(i => i.message) },
    actorRole: 'reviewer',
  });

  // 写入 wiki/pitfalls/
  try {
    const companyId = goalExec?.goalId
      ? (await prisma.goal.findUnique({ where: { id: goalExec.goalId }, select: { companyId: true } }))?.companyId
      : undefined;
    if (companyId) {
      const issueList = review.issues.slice(0, 10).map((i: any) => `- [${i.severity}] ${i.message}`).join('\n');
      knowledgeBus.recordPattern({
        type: 'failure',
        title: `审查循环耗尽: ${task.name}`,
        content: `任务"${task.name}"经过 ${cycle} 轮审查仍未通过（最后一轮 score: ${review.score}）。审查发现:\n${issueList || '无具体问题'}\n需要人工介入分析根因。`,
        severity: 'critical',
        timestamp: Date.now(),
        context: { taskId, projectId: task.projectId, reviewCycles: cycle, score: review.score },
      });

      // 审计: Pitfall 创建
      recordDecision({
        eventType: 'wiki.pitfall_created',
        entityType: 'wiki',
        entityId: `pitfalls/review-exhausted-${taskId.slice(0, 8)}.md`,
        companyId,
        projectId: task.projectId,
        summary: `Pitfall 创建: ${task.name}（审查 ${cycle}/${MAX_REVIEW_CYCLES} 轮未通过）`,
        actorRole: 'reviewer',
      });
    }
  } catch (e) {
    logger.warn('[AgentEventListener] Failed to record pitfall on exhaustion', { error: String(e) });
  }
}

/**
 * 执行审查循环 + 处理审查结果
 * 从 handleMessage 的 review 部分提取。
 */
export async function handleReviewCycle(
  task: { projectId: string; description: string | null; name: string; acceptanceCriteria?: unknown },
  taskId: string,
  goalExecutionId: string,
  goalId: string | undefined,
  worktree: string,
  previousCycle: number,
  completionOutput: Record<string, any> | undefined,
  goalExec: { goalId: string; input: unknown },
  isCompleted: boolean,
  data: Record<string, unknown>,
): Promise<void> {
  if (previousCycle >= MAX_REVIEW_CYCLES) {
    // 已达到最大循环次数，跳过审查，标记需要人工介入
    logger.warn('[AgentEventListener] Max review cycles reached, escalating', {
      taskId,
      cycles: previousCycle,
    });
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'blocked',
        description: (task.description || task.name) +
          `\n\n⚠️ 已达最大审查循环次数（${MAX_REVIEW_CYCLES}），需要人工介入。`,
      },
    });
    await notifyEscalation(taskId, task.projectId);

    // 审计: 审查循环耗尽
    recordDecision({
      eventType: 'review.exhausted',
      entityType: 'review',
      entityId: taskId,
      projectId: task.projectId,
      summary: `审查循环耗尽（${MAX_REVIEW_CYCLES} 轮）: ${task.name}`,
      details: { cycles: previousCycle, taskName: task.name },
      actorRole: 'reviewer',
    });

    // 写入 wiki/pitfalls/，供后续同类任务参考
    try {
      const companyId = goalExec?.goalId
        ? (await prisma.goal.findUnique({ where: { id: goalExec.goalId }, select: { companyId: true } }))?.companyId
        : undefined;
      if (companyId) {
        const reviewReportPath = path.join(worktree, '.review-report.json');
        let reviewIssues = '审查报告不可用';
        if (fs.existsSync(reviewReportPath)) {
          const report = JSON.parse(fs.readFileSync(reviewReportPath, 'utf-8'));
          reviewIssues = (report.issues || []).map((i: any) => `- [${i.severity}] ${i.message}`).join('\n') || '无具体问题';
        }
        const pitfallId = `review-exhausted-${taskId.slice(0, 8)}`;
        knowledgeBus.recordPattern({
          type: 'failure',
          title: `审查循环耗尽: ${task.name}`,
          content: `任务"${task.name}"经过 ${MAX_REVIEW_CYCLES} 轮审查仍未通过。审查发现:\n${reviewIssues}\n需要人工介入分析根因。`,
          severity: 'critical',
          timestamp: Date.now(),
          context: { taskId, projectId: task.projectId, reviewCycles: MAX_REVIEW_CYCLES },
        });
        logger.info('[AgentEventListener] Pitfall recorded', { pitfallId, taskId, goalExecutionId, goalId });

        // 审计: Pitfall 创建
        recordDecision({
          eventType: 'wiki.pitfall_created',
          entityType: 'wiki',
          entityId: `pitfalls/${pitfallId}.md`,
          companyId,
          projectId: task.projectId,
          summary: `Pitfall 创建: ${task.name}（审查 ${MAX_REVIEW_CYCLES} 轮耗尽）`,
          actorRole: 'reviewer',
        });
      }
    } catch (e) {
      logger.warn('[AgentEventListener] Failed to record pitfall', { goalExecutionId, goalId, error: String(e) });
    }
    return;
  }

  // Review Agent（同步，阻塞）
  try {
    // 从 RoleConfig 加载 Reviewer 立场
    let reviewerStances: any[] | undefined;
    try {
      const goal = goalId ? await prisma.goal.findUnique({ where: { id: goalId }, select: { companyId: true } }) : null;
      if (goal?.companyId) {
        const reviewerConfig = await roleConfigService.getOrCreate('reviewer', goal.companyId);
        reviewerStances = reviewerConfig.stances;
      }
    } catch (e) {
      logger.warn('[AgentEventListener] Reviewer stance loading failed, using defaults', { error: String(e) });
    }

    const review = await reviewAgent.review({
      taskId,
      projectId: task.projectId,
      worktree,
      taskDescription: task.description || task.name,
      acceptanceCriteria: (task.acceptanceCriteria || []) as string[],
      cycle: previousCycle + 1,
      stances: reviewerStances,
    });

    // 审计: Review 完成
    recordDecision({
      eventType: 'review.completed',
      entityType: 'review',
      entityId: taskId,
      projectId: task.projectId,
      summary: review.approved
        ? `Review 通过（cycle: ${previousCycle + 1}, score: ${review.score}）`
        : `Review 未通过（cycle: ${previousCycle + 1}, score: ${review.score}, issues: ${review.issues.length}）`,
      details: { approved: review.approved, score: review.score, issueCount: review.issues.length, cycle: previousCycle + 1 },
      actorRole: 'reviewer',
    });

    // P0a: Extract knowledge from review result (fire-and-forget)
    knowledgeAgent.extractFromReview(review, taskId, task.projectId).catch(e => {
      logger.warn('[AgentEventListener] extractFromReview failed', { error: String(e) });
    });

    if (!review.approved) {
      logger.warn('[AgentEventListener] Review not approved', {
        taskId,
        cycle: previousCycle + 1,
        score: review.score,
        issueCount: review.issues.length,
      });

      // Phase 3: Record review rejection for cross-execution pattern analysis
      recordReviewRejected(goalExec.goalId, taskId, previousCycle + 1);

      // BP-018: 跨并行 Executor 实时识别
      const systemicIssues = review.issues
        .filter(i => i.severity === 'error' || i.severity === 'warning')
        .slice(0, 3);
      if (systemicIssues.length > 0 && goalExec?.goalId) {
        try {
          const siblingExecs = await prisma.goalExecution.findMany({
            where: { goalId: goalExec.goalId, status: { in: ['pending', 'running'] }, id: { not: goalExecutionId } },
            select: { id: true, input: true },
          });
          if (siblingExecs.length > 0) {
            const { eventStore } = await import('../../core/event-store.js');
            const pubRedis = eventStore;
            await pubRedis.publish('events:goal', JSON.stringify({
              event_type: 'goal.runtime_constraints',
              goalId: goalExec.goalId,
              constraints: systemicIssues.map(i => `⚠️ [跨执行者预警] ${i.message}`),
              sourceExecutionId: goalExecutionId,
            }));

            logger.info('[BP-018] Systemic issues broadcast to siblings', {
              goalId: goalExec.goalId,
              siblingCount: siblingExecs.length,
              issues: systemicIssues.map(i => i.message),
            });
          }
        } catch (e) {
          logger.warn('[BP-018] Failed to broadcast systemic issues', { error: String(e) });
        }
      }

      if (previousCycle + 1 >= MAX_REVIEW_CYCLES) {
        await handleReviewExhausted(taskId, task, goalExecutionId, goalId, worktree, previousCycle + 1, review, goalExec);
      } else {
        // 重置 GoalExecution 为 pending，触发修复循环
        const reportPath = path.join(worktree, '.review-report.json');
        const reportContext = fs.existsSync(reportPath)
          ? `\n\nThe previous review found issues. Read .review-report.json in the worktree for details.\nFix all issues with severity 'error' and 'warning'.\nThen re-run tests and verification before claiming completion.`
          : `\n\nReview found issues: ${review.issues.map(i => i.message).join('; ')}`;

        await prisma.goalExecution.update({
          where: { id: goalExecutionId },
          data: {
            status: 'pending',
            input: JSON.stringify({
              ...((goalExec.input as unknown as Record<string, unknown>) || {}),
              reviewReportPath: path.join(worktree, '.review-report.json'),
              reviewCycle: previousCycle + 1,
              fixContext: reportContext,
            }),
          },
        });
        logger.info('[AgentEventListener] Re-queued execution for review fixes', {
          taskId,
          cycle: previousCycle + 1,
        });
      }
    }
  } catch (reviewErr) {
    logger.error('[AgentEventListener] Review agent failed (non-blocking)', { error: String(reviewErr) });
  }
}
