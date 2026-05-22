/**
 * Agent Event Listener - 监听 AgentExecutor 的 Redis 事件
 *
 * 订阅 'events' 频道，处理 agent.completed / agent.failed 事件，
 * 更新 GoalExecution 和 Task 状态。
 */

import { eventStore, EventStore } from '../../core/event-store.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { goalService } from './goal.service.js';
import { discordNotifier } from '../../utils/discord-notifier.js';
import { reviewAgent } from '../agents/review-agent.service.js';
import { roleConfigService } from '../roles/role-config.service.js';
import { knowledgeAgent } from '../agents/knowledge-agent.service.js';
import { afterAgentComplete, recordDecision } from '@dommaker/studio-shared/harness/hooks';
import { knowledgeKeeper } from '@dommaker/studio-shared';
import { recordFailure, recordSuccess, recordReviewRejected, runEvolution } from '../harness/evolution.service.js';
import type { ReviewReport } from '../agents/review-report.js';

const MAX_REVIEW_CYCLES = 3;

export class AgentEventListener {
  private started = false;

  start(): void {
    if (this.started) return;

    eventStore.subscribe('events', (message: string) => {
      this.handleMessage(message).catch(e => {
        logger.error('[AgentEventListener] Error handling message', { error: String(e) });
      });
    });

    this.started = true;
    logger.info('[AgentEventListener] Started');
  }

  stop(): void {
    this.started = false;
    logger.info('[AgentEventListener] Stopped');
  }

  private async handleMessage(raw: string): Promise<void> {
    let event: { event_type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    const eventType = event.event_type || '';
    if (eventType !== 'agent.completed' && eventType !== 'agent.failed') return;

    const data = event.data || {};
    // executionId 是 AgentExecutor session loop 的事件 key；
    // goalExecutionId 是旧 task-assignment 路径的 key，兼容两路径
    const goalExecutionId = (data.goalExecutionId || data.executionId) as string | undefined;
    let goalId = data.goalId as string | undefined;
    const executionId = data.executionId as string | undefined;
    const worktree = data.worktree as string | undefined;

    if (!goalExecutionId) return;

    // session loop 路径没有 goalId → 从 DB 查
    if (!goalId) {
      try {
        const exec = await prisma.goalExecution.findUnique({
          where: { id: goalExecutionId },
          select: { goalId: true },
        });
        goalId = exec?.goalId || undefined;
      } catch {
        // ignore, checkGoalCompletion won't run but execution update still works
      }
    }

    const isCompleted = eventType === 'agent.completed';

    logger.info('[AgentEventListener] Processing event', {
      eventType,
      goalExecutionId,
      executionId,
    });

    // 构建完成输出（成功时从 worktree 提取结构化 output）
    let completionOutput: Record<string, any> | undefined;
    if (isCompleted && worktree && fs.existsSync(worktree)) {
      completionOutput = this.buildCompletionOutput(worktree);
    }

    // 更新 GoalExecution 状态
    try {
      await goalService.updateStepExecution(goalExecutionId, {
        status: isCompleted ? 'succeeded' : 'failed',
        ...(completionOutput ? { output: completionOutput } : {}),
        error: isCompleted ? undefined : (data.error as string) || 'Agent execution failed',
      });
      logger.info('[AgentEventListener] GoalExecution updated', {
        goalExecutionId, executionId, goalId,
        status: isCompleted ? 'succeeded' : 'failed',
        hasOutput: !!completionOutput,
      });

      // 🆕 更新 Wiki 项目页执行结果
      if (goalId) {
        try {
          const goal = await prisma.goal.findUnique({ where: { id: goalId }, select: { companyId: true, context: true } });
          if (goal?.companyId) {
            const projectId = (goal.context as any)?.projectId as string | undefined;
            if (projectId) {
              const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pmoNumber: true } });
              if (project) {
                const ge = await prisma.goalExecution.findUnique({ where: { id: goalExecutionId }, select: { input: true } });
                const acGroupId = ((ge?.input as any)?.acGroup?.id as string) || undefined;
                knowledgeKeeper.ingestExecutionResult(goal.companyId, project.pmoNumber, {
                  acGroupId,
                  status: isCompleted ? 'succeeded' : 'failed',
                  summary: isCompleted
                    ? `AC 组完成（sessions: ${data.sessionCount || '?'}）`
                    : `AC 组失败: ${(data.error as string)?.slice(0, 100) || '未知错误'}`,
                  changedFiles: completionOutput?.changedFiles,
                  error: isCompleted ? undefined : (data.error as string),
                });

                // 🆕 审计: Wiki 页面更新
                recordDecision({
                  eventType: 'wiki.page_updated',
                  entityType: 'wiki',
                  entityId: `projects/${project.pmoNumber}.md`,
                  companyId: goal.companyId,
                  projectId,
                  summary: isCompleted
                    ? `Wiki 项目页更新: ${project.pmoNumber} — ${acGroupId || '执行'} 完成`
                    : `Wiki 项目页更新: ${project.pmoNumber} — ${acGroupId || '执行'} 失败`,
                  actorRole: 'knowledge_keeper',
                });
              }
            }
          }
        } catch (e) {
          logger.warn('[AgentEventListener] Wiki update failed (non-blocking)', { goalExecutionId, goalId, error: String(e) });
        }
      }

      // 审计: Execution 完成
      recordDecision({
        eventType: isCompleted ? 'execution.completed' : 'execution.failed',
        entityType: 'execution',
        entityId: goalExecutionId,
        summary: isCompleted
          ? `Executor 完成（sessions: ${data.sessionCount || '?'}）`
          : `Executor 失败: ${(data.error as string) || '未知错误'}`,
        details: isCompleted ? { sessionCount: data.sessionCount } : { error: data.error },
        actorRole: 'executor',
      });
    } catch (e) {
      logger.error('[AgentEventListener] Failed to update GoalExecution', {
        goalExecutionId, executionId, goalId,
        error: String(e),
      });
    }

    // 更新 Task 状态 — 通过 goalExecutionId 找到关联的 Task
    try {
      const goalExec = await prisma.goalExecution.findUnique({
        where: { id: goalExecutionId },
        select: { input: true, goalId: true },
      });

      if (goalExec) {
        const input = goalExec.input as Record<string, unknown> | null;
        const taskId = input?.taskId as string | undefined;

        if (taskId) {
          // 加载完整 Task 数据
          const task = await prisma.task.findUnique({ where: { id: taskId } });

          await prisma.task.update({
            where: { id: taskId },
            data: {
              status: isCompleted ? 'completed' : 'failed',
              completedAt: isCompleted ? new Date() : undefined,
            },
          });
          logger.info('[AgentEventListener] Task updated', {
            taskId, goalExecutionId,
            status: isCompleted ? 'completed' : 'failed',
          });

          // 如果任务成功，触发 Review Agent + Knowledge Agent
          if (isCompleted && worktree && task) {
            // 读取上一轮审查报告的 cycle 数（如果存在）
            const previousCycle = this.readReviewCycle(worktree);

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
              await this.notifyEscalation(taskId, task.projectId);

              // 🆕 审计: 审查循环耗尽
              recordDecision({
                eventType: 'review.exhausted',
                entityType: 'review',
                entityId: taskId,
                projectId: task.projectId,
                summary: `审查循环耗尽（${MAX_REVIEW_CYCLES} 轮）: ${task.name}`,
                details: { cycles: previousCycle, taskName: task.name },
                actorRole: 'reviewer',
              });

              // 🆕 写入 wiki/pitfalls/，供后续同类任务参考
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
                  knowledgeKeeper.ingestPage(companyId, {
                    path: `pitfalls/${pitfallId}.md`,
                    title: `审查循环耗尽: ${task.name}`,
                    content: `## 问题\n任务"${task.name}"经过 ${MAX_REVIEW_CYCLES} 轮审查仍未通过。\n\n## 审查发现\n${reviewIssues}\n\n## 关联\n- Task: ${taskId}\n- Project: ${task.projectId}\n\n## 处理\n需要人工介入分析根因。`,
                    frontmatter: {
                      maturity: 'draft',
                      sourceTaskId: taskId,
                      sourceProjectId: task.projectId,
                      reviewCycles: MAX_REVIEW_CYCLES,
                      createdAt: new Date().toISOString(),
                    },
                  });
                  logger.info('[AgentEventListener] Pitfall recorded', { pitfallId, taskId, goalExecutionId, goalId });

                  // 🆕 审计: Pitfall 创建
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
            } else {
              // Review Agent（同步，阻塞）
              try {
                // 🆕 从 RoleConfig 加载 Reviewer 立场
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
                  acceptanceCriteria: task.acceptanceCriteria || [],
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

                  // 🆕 BP-018: 跨并行 Executor 实时识别
                  // 提取系统性 issue（通用模式），通知同 Goal 的其他 pending executor
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
                    // 最后一轮仍未通过，标记 blocked 并通知
                    await prisma.task.update({
                      where: { id: taskId },
                      data: {
                        status: 'blocked',
                        description: (task.description || task.name) +
                          `\n\n[Review #${previousCycle + 1}] Score: ${review.score}\nIssues: ${review.issues.map(i => i.message).join('; ')}` +
                          `\n\n⚠️ 已达最大审查循环次数，需要人工介入。`,
                      },
                    });
                    await this.notifyEscalation(taskId, task.projectId);

                    // 🆕 审计: 审查循环耗尽（最后一轮未通过）
                    recordDecision({
                      eventType: 'review.exhausted',
                      entityType: 'review',
                      entityId: taskId,
                      projectId: task.projectId,
                      summary: `审查耗尽（${previousCycle + 1}/${MAX_REVIEW_CYCLES} 轮未通过，score: ${review.score}）: ${task.name}`,
                      details: { cycle: previousCycle + 1, score: review.score, issues: review.issues.slice(0, 5).map(i => i.message) },
                      actorRole: 'reviewer',
                    });

                    // 🆕 写入 wiki/pitfalls/
                    try {
                      const companyId = goalExec?.goalId
                        ? (await prisma.goal.findUnique({ where: { id: goalExec.goalId }, select: { companyId: true } }))?.companyId
                        : undefined;
                      if (companyId) {
                        const issueList = review.issues.slice(0, 10).map((i: any) => `- [${i.severity}] ${i.message}`).join('\n');
                        const pitfallId = `review-exhausted-${taskId.slice(0, 8)}`;
                        knowledgeKeeper.ingestPage(companyId, {
                          path: `pitfalls/${pitfallId}.md`,
                          title: `审查循环耗尽: ${task.name}`,
                          content: `## 问题\n任务"${task.name}"经过 ${previousCycle + 1} 轮审查仍未通过（最后一轮 score: ${review.score}）。\n\n## 审查发现\n${issueList || '无具体问题'}\n\n## 关联\n- Task: ${taskId}\n- Project: ${task.projectId}\n\n## 处理\n需要人工介入分析根因。`,
                          frontmatter: { maturity: 'draft', sourceTaskId: taskId, reviewCycles: previousCycle + 1, createdAt: new Date().toISOString() },
                        });
                      }
                    } catch (e) {
                      logger.warn('[AgentEventListener] Failed to record pitfall on exhaustion', { error: String(e) });
                    }

                    // 🆕 审计: Pitfall 创建（最后一轮未通过）
                    try {
                      const pitfallCompanyId = goalExec?.goalId
                        ? (await prisma.goal.findUnique({ where: { id: goalExec.goalId }, select: { companyId: true } }))?.companyId
                        : undefined;
                      if (pitfallCompanyId) {
                        recordDecision({
                          eventType: 'wiki.pitfall_created',
                          entityType: 'wiki',
                          entityId: `pitfalls/review-exhausted-${taskId.slice(0, 8)}.md`,
                          companyId: pitfallCompanyId,
                          projectId: task.projectId,
                          summary: `Pitfall 创建: ${task.name}（审查 ${previousCycle + 1}/${MAX_REVIEW_CYCLES} 轮未通过）`,
                          actorRole: 'reviewer',
                        });
                      }
                    } catch (e) {
                      logger.warn('[AgentEventListener] Audit recording failed (non-blocking)', { error: String(e) });
                    }
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
                        input: {
                          ...((goalExec.input as Record<string, unknown>) || {}),
                          reviewReportPath: path.join(worktree, '.review-report.json'),
                          reviewCycle: previousCycle + 1,
                          fixContext: reportContext,
                        },
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

            // Knowledge Agent（异步，不阻塞）
            knowledgeAgent.extract({
              taskId,
              projectId: task.projectId,
              worktree,
              taskDescription: task.description || task.name,
              result: 'success',
            }).catch(e => {
              logger.error('[AgentEventListener] Knowledge agent failed (non-blocking)', { error: String(e) });
            });

            // P0a: Extract from completion output (fire-and-forget)
            if (completionOutput) {
              knowledgeAgent.extractFromCompletion(completionOutput, taskId, task.projectId).catch(e => {
                logger.warn('[AgentEventListener] extractFromCompletion failed', { error: String(e) });
              });
            }

            // Phase 3: Skill 提取（面向 GoalExecution，自动检测可复用模式）
            if (goalExecutionId) {
              import('../tools-std/skill-extraction.service.js').then(({ skillExtractionService }) => {
                skillExtractionService.extractFromGoalExecution(goalExecutionId).then(skill => {
                  if (skill) logger.info('[AgentEventListener] New skill pattern extracted', { name: skill.name, confidence: skill.confidence });
                }).catch(e => logger.warn('[AgentEventListener] Skill extraction failed', { error: String(e) }));
              }).catch((e) => {
                logger.error('[AgentEventListener] Failed to import skill-extraction service', { error: String(e) });
              });
            }

            // Phase 3: agent 完成 hook（TraceCollector, etc.）
            afterAgentComplete({
              executionId: goalExecutionId,
              success: isCompleted,
              sessionCount: (data.sessionCount as number),
            }).catch(e => {
              logger.error('[AgentEventListener] afterAgentComplete hook failed', { error: String(e) });
            });

            // 约束进化：成功执行降低失败计数
            recordSuccess();
          }

          // 如果任务失败，也触发 Knowledge Agent 提取教训
          if (!isCompleted && worktree && task) {
            knowledgeAgent.extract({
              taskId,
              projectId: task.projectId,
              worktree,
              taskDescription: task.description || task.name,
              result: 'failure',
              error: (data.error as string) || 'Unknown error',
            }).catch(e => {
              logger.error('[AgentEventListener] Knowledge agent failed (non-blocking)', { error: String(e) });
            });

            // P0a: Extract from error chain (fire-and-forget)
            knowledgeAgent.extractFromError(
              (data.error as string) || 'Unknown error',
              JSON.stringify({ taskDescription: task.description || task.name, eventType, executionId }),
              task.description || task.name,
              taskId,
              task.projectId,
            ).catch(e => {
              logger.warn('[AgentEventListener] extractFromError failed', { error: String(e) });
            });

            // 约束进化：记录失败 + 触发进化检查
            recordFailure();
            runEvolution().then(result => {
              if (result) logger.info('[AgentEventListener] Constraint evolution triggered', result);
            }).catch(e => logger.warn('[AgentEventListener] Evolution check failed', { error: String(e) }));
          }

          // Goal completion check handled by GoalScheduler (authoritative path)
        }
      }
    } catch (e) {
      logger.error('[AgentEventListener] Failed to update Task', { error: String(e) });
    }
  }

  /**
   * 读取 worktree 中的审查报告 cycle 数
   */
  private readReviewCycle(worktree: string): number {
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
  private async notifyEscalation(taskId: string, projectId: string): Promise<void> {
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
   * 从 worktree 构建结构化完成输出（INF-002 Part B）
   *
   * 读取 .progress.json、git diff 等，生成 GoalExecution.output。
   * 后续 pending step 的 dispatch 会通过 getSiblingContext() 消费此 output。
   *
   * 纯 best-effort：任何失败返回空 output，不阻塞完成流程。
   */
  private buildCompletionOutput(worktree: string): Record<string, any> {
    const output: Record<string, any> = {
      summary: '',
      changedFiles: [],
      completedAcs: [],
      siblingAdvice: [],
    };

    try {
      // 读取 .progress.json
      const progressPath = path.join(worktree, '.progress.json');
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        output.summary = `完成 ${progress.completedSteps?.length || 0} 个步骤。${progress.notes || ''}`;
        output.completedAcs = progress.completedSteps || [];
      }
    } catch {
      // .progress.json 缺失或损坏，非致命
    }

    // git diff 获取改动文件列表
    try {
      const diffOut = execSync(
        'git diff --name-only HEAD~1..HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || git diff --name-only 2>/dev/null || true',
        { cwd: worktree, encoding: 'utf-8', timeout: 5000 },
      );
      output.changedFiles = diffOut.split('\n').filter(Boolean);
    } catch {
      // git diff 失败，非致命
    }

    // 解析 @sibling 标记（agent 在 notes 中留下的跨组级建议）
    try {
      const progressPath = path.join(worktree, '.progress.json');
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        const notes: string = progress.notes || '';
        const adviceRegex = /@sibling\s+(\S+):\s*(.+)/g;
        let match: RegExpExecArray | null;
        while ((match = adviceRegex.exec(notes)) !== null) {
          output.siblingAdvice.push({
            targetGroupId: match[1],
            message: match[2].trim(),
            priority: 'medium',
          });
        }
      }
    } catch {
      // 解析失败，非致命
    }

    return output;
  }

}

export const agentEventListener = new AgentEventListener();
