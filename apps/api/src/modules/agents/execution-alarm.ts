/**
 * Pipeline Alarm — 管线阶段失败统一处理
 *
 * 职责：通知(Discord) + 知识沉淀(KnowledgeStore)
 *
 * @deprecated Pipeline（Goal 系统）已废弃。DB 状态更新已移除（GoalExecution 表不再写入）。
 * 通知 + 知识沉淀保留供 MonitorAgent 超时告警使用，Phase 4 整体删除。
 *
 * 调用方：
 * - MonitorAgent autoAbandon/autoFail → severity: 'timeout'
 */

import { logger } from '@dommaker/studio-shared';
import { notifyService } from '../outbound-notify/notify.service.js';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';

export interface AlarmContext {
  /** WorkUnit or GoalExecution ID (optional) */
  executionId?: string;
  /** Goal or parent WorkUnit ID */
  goalId: string;
  /** Pipeline phase that failed */
  phase: 'analyst' | 'executing' | 'integration' | 'review' | 'deploy' | 'knowledge';
  /** Error message (truncated to 300 chars for notification) */
  error: string;
  /** Failure severity */
  severity: 'timeout' | 'error' | 'exhausted';
}

/**
 * 管线阶段失败统一处理：Discord 通知 + 知识沉淀
 *
 * 所有副作用 non-blocking：任一环节失败不影响其他环节。
 */
export async function onPhaseFailure(ctx: AlarmContext): Promise<void> {
  // 1. 通知：Discord via NotifyService
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

  // 2. 知识：沉淀失败模式
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
