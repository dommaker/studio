/**
 * Pipeline Alarm — 管线阶段失败统一处理
 *
 * 职责：终止(DB) + 通知(Discord) + 知识沉淀(KnowledgeStore)
 *
 * 调用方：
 * - GoalScheduler checkTimedOutExecutions → severity: 'timeout'
 * - goal-review.ts review 耗尽 → severity: 'exhausted'
 * - MonitorAgent autoAbandon/autoFail → severity: 'error'
 * - scheduler-dispatch.ts catch → severity: 'error'
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { notifyService } from '../outbound-notify/notify.service.js';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';

export interface AlarmContext {
  /** GoalExecution ID (optional — some phases like review don't have one) */
  executionId?: string;
  /** Goal ID */
  goalId: string;
  /** Pipeline phase that failed */
  phase: 'analyst' | 'executing' | 'integration' | 'review' | 'deploy' | 'knowledge';
  /** Error message (truncated to 300 chars for notification) */
  error: string;
  /** Failure severity */
  severity: 'timeout' | 'error' | 'exhausted';
}

/**
 * 管线阶段失败统一处理：DB 状态 + Discord 通知 + 知识沉淀
 *
 * 所有副作用 non-blocking：任一环节失败不影响其他环节。
 */
export async function onPhaseFailure(ctx: AlarmContext): Promise<void> {
  // 1. 终止：标记 DB（executionId 存在时）
  if (ctx.executionId) {
    try {
      await prisma.goalExecution.update({
        where: { id: ctx.executionId },
        data: {
          status: 'closed',
          metadata: JSON.stringify({ error: JSON.stringify({ message: ctx.error, phase: ctx.phase }) }),
        },
      });
    } catch { /* execution may not exist */ }
  }

  // 2. 通知：Discord via NotifyService
  const notifyType = ctx.severity === 'timeout' ? 'timeout' as const
    : ctx.severity === 'exhausted' ? 'human-needed' as const
    : 'task-failed' as const;

  try {
    if (typeof notifyService.send === 'function') {
      await notifyService.send({
        type: notifyType,
        taskId: ctx.executionId,
        title: `管线 ${ctx.phase} 阶段${ctx.severity === 'timeout' ? '超时' : ctx.severity === 'exhausted' ? '耗尽' : '失败'}`,
        content: `Goal: ${ctx.goalId.slice(0, 8)}\nPhase: ${ctx.phase}\nError: ${ctx.error.slice(0, 300)}`,
        priority: ctx.severity === 'exhausted' ? 'high' : 'medium',
      });
    }
  } catch (e) {
    logger.warn('[PipelineAlarm] Notification failed', { error: String(e) });
  }

  // 3. 知识：沉淀失败模式
  try {
    if (typeof knowledgeBus.recordPattern === 'function') {
      await knowledgeBus.recordPattern({
        source: 'ops',
        type: 'failure',
        title: `管线 ${ctx.phase} ${ctx.severity}: ${ctx.error.slice(0, 50)}`,
        content: `goalId: ${ctx.goalId}\nphase: ${ctx.phase}\nerror: ${ctx.error}`,
        severity: ctx.severity === 'exhausted' ? 'critical' : 'warning',
        timestamp: Date.now(),
        context: { goalId: ctx.goalId, phase: ctx.phase, severity: ctx.severity },
      });
    }
  } catch { /* non-blocking */ }
}
