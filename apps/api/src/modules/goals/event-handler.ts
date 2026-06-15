/**
 * Event Handler — Agent 事件核心处理逻辑
 *
 * 从 agent-event-listener.ts 提取。
 * 委托 review-orchestrator.ts 和 knowledge-promoter.ts 处理子流程。
 */
import { eventStore } from '../../core/event-store.js';
import { eventBus } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { goalService } from './goal.service.js';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import { recordDecision } from '@dommaker/studio-shared/harness/hooks';
import { recordFailure, recordSuccess, runEvolution } from '../harness/evolution.service.js';
import { readReviewCycle, handleReviewCycle, MAX_REVIEW_CYCLES } from './review-orchestrator.js';
import { triggerPostCompletionKnowledge, triggerFailureKnowledge } from './knowledge-promoter.js';

/** Metadata file patterns that should not trigger review */
const METADATA_PREFIXES = ['.', '.claude/'];

/**
 * 检查 worktree 是否有实际代码变更（排除 metadata 文件）
 *
 * 使用与 review-agent 相同的 base ref（REVIEW_BASE_REF 或 HEAD~1）。
 * 过滤 .progress.json、.review-report.json、.agent.log、.prompt.md、.claude/ 等管线文件。
 *
 * @param worktree - git worktree 路径
 * @returns true 表示有代码变更，应触发 review
 */
export function hasCodeChanges(worktree: string): boolean {
  try {
    const baseRef = process.env.REVIEW_BASE_REF || 'HEAD~1';
    const diffOut = execSync(
      `git diff ${baseRef} --name-only 2>/dev/null || git diff --cached --name-only 2>/dev/null || git diff --name-only 2>/dev/null || echo ""`,
      { cwd: worktree, encoding: 'utf-8', timeout: 5000 },
    );
    const files = diffOut.trim().split('\n').filter(f => f.length > 0);
    if (files.length === 0) return false;

    // 过滤 metadata 文件：以 . 开头的根目录文件/目录
    const codeFiles = files.filter(f => !METADATA_PREFIXES.some(p => f.startsWith(p)));
    return codeFiles.length > 0;
  } catch {
    // git 命令失败 → 安全默认值：触发 review（不阻断）
    return true;
  }
}

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
        // ignore
      }
    }

    const isCompleted = eventType === 'agent.completed';

    logger.info('[AgentEventListener] Processing event', {
      eventType,
      goalExecutionId,
      executionId,
    });

    // 构建完成输出
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

      // Record FailureEvent for failed agent (upsert for dedup with scheduler-dispatch)
      if (!isCompleted && goalId) {
        try {
          const { classifyFailure } = await import('../triage/error-class.js');
          const errorMsg = (data.error as string) || 'Agent execution failed';
          const classification = classifyFailure(errorMsg);
          await prisma.failureEvent.upsert({
            where: { executionId_category: { executionId: goalExecutionId, category: classification.category } },
            create: {
              executionId: goalExecutionId,
              goalId,
              category: classification.category,
              severity: classification.severity,
              errorMessage: errorMsg.slice(0, 1000),
              routeTarget: 'human', // not routed here — routing only in scheduler-dispatch
              matchedPattern: classification.matchedPattern,
            },
            update: {
              severity: classification.severity,
              errorMessage: errorMsg.slice(0, 1000),
              matchedPattern: classification.matchedPattern,
            },
          });
        } catch { /* non-blocking */ }
      }

      // 事件驱动：通知 scheduler 有 step 完成，触发下一轮调度
      if (isCompleted && goalId) {
        eventBus.publish('goal.stepCompleted', { goalId, goalExecutionId });
      }

      // 更新 Wiki 项目页执行结果
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
                knowledgeBus.recordPattern({
                  type: isCompleted ? 'pattern' : 'failure',
                  title: `${project.pmoNumber} ${acGroupId || ''} ${isCompleted ? '完成' : '失败'}`,
                  content: isCompleted
                    ? `AC 组完成（sessions: ${data.sessionCount || '?'}）${completionOutput?.changedFiles?.length ? ` 改动: ${completionOutput.changedFiles.join(', ')}` : ''}`
                    : `AC 组失败: ${(data.error as string)?.slice(0, 200) || '未知错误'}`,
                  severity: isCompleted ? 'info' : 'warning',
                  timestamp: Date.now(),
                  context: { goalId, acGroupId, pmoNumber: project.pmoNumber },
                });

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
        const input = goalExec.input as unknown as Record<string, unknown> | null;
        const taskId = input?.taskId as string | undefined;

        if (taskId) {
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

          // 成功 → Review + Knowledge
          if (isCompleted && worktree && task) {
            // 条件触发：仅 worktree 有代码变更时执行审查
            if (hasCodeChanges(worktree)) {
              const previousCycle = readReviewCycle(worktree);

              await handleReviewCycle(
                task, taskId, goalExecutionId, goalId, worktree,
                previousCycle, completionOutput, goalExec, isCompleted, data,
              );
            } else {
              logger.info('[Review] Skipped — no code changes in worktree', { taskId, worktree });
            }

            triggerPostCompletionKnowledge(
              taskId, task, worktree, completionOutput,
              goalExecutionId, goalId, data,
            );

            // 约束进化：成功执行降低失败计数
            recordSuccess();
          }

          // 失败 → Knowledge 提取教训
          if (!isCompleted && worktree && task) {
            triggerFailureKnowledge(taskId, task, worktree, data, eventType, executionId);

            // 约束进化：记录失败 + 触发进化检查
            recordFailure();
            runEvolution().then(result => {
              if (result) logger.info('[AgentEventListener] Constraint evolution triggered', result);
            }).catch(e => logger.warn('[AgentEventListener] Evolution check failed', { error: String(e) }));
          }
        }
      }
    } catch (e) {
      logger.error('[AgentEventListener] Failed to update Task', { error: String(e) });
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
      const progressPath = path.join(worktree, '.progress.json');
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        output.summary = `完成 ${progress.completedSteps?.length || 0} 个步骤。${progress.notes || ''}`;
        output.completedAcs = progress.completedSteps || [];
      }
    } catch {
      // .progress.json 缺失或损坏，非致命
    }

    try {
      const diffOut = execSync(
        'git status --porcelain 2>/dev/null | sed "s/^...//" | sort -u || git diff --name-only --cached 2>/dev/null | sort -u || echo ""',
        { cwd: worktree, encoding: 'utf-8', timeout: 5000 },
      );
      output.changedFiles = diffOut.trim().split('\n').filter(f => f.length > 0 && !f.includes('.agent.log') && !f.includes('.progress.json') && !f.includes('.prompt.md'));
    } catch {
      // git status 失败，非致命
    }

    if (output.changedFiles.length === 0) {
      try {
        const altOut = execSync('find . -name "*.ts" -newer .agent.log -not -path "*/node_modules/*" 2>/dev/null | head -50 || echo ""', { cwd: worktree, encoding: 'utf-8', timeout: 5000 });
        output.changedFiles = altOut.trim().split('\n').filter(f => f.length > 0);
      } catch { /* best-effort */ }
    }

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
