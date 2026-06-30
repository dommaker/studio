/**
 * Stale Recovery — 从 GoalScheduler 提取的超时 GC + 孤儿恢复逻辑
 *
 * AS-026: 提取为独立函数，供 Trigger 和 Scheduler 共用。
 * 函数设计为 idempotent，可安全并发调用。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { goalService } from './goal.service.js';
import { onPhaseFailure } from '../agents/execution-alarm.js';

const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

/**
 * 释放超时 GoalExecution：status=running + (timeoutAt < now || startedAt > 15min ago)
 * @returns 释放数量
 */
export async function recoverStaleExecutions(): Promise<number> {
  const now = new Date();
  const fallbackThreshold = new Date(Date.now() - 15 * 60_000);

  const timedOut = await prisma.goalExecution.findMany({
    where: {
      status: 'running',
      OR: [
        { timeoutAt: { lt: now } },
        { timeoutAt: null, startedAt: { lt: fallbackThreshold } },
      ],
    },
    select: { id: true, goalId: true, stepIndex: true, startedAt: true, timeoutAt: true, input: true },
  });

  for (const exec of timedOut) {
    const goalId = exec.goalId;
    const stepIndex = exec.stepIndex;

    logger.warn('[StaleRecovery] Execution timed out', {
      executionId: exec.id,
      goalId,
      stepIndex,
      startedAt: exec.startedAt,
      timeoutAt: exec.timeoutAt,
    });

    await onPhaseFailure({
      executionId: exec.id,
      goalId,
      phase: stepIndex === 999 ? 'integration' : 'executing',
      error: `Execution timed out (startedAt: ${exec.startedAt?.toISOString() || 'unknown'})`,
      severity: 'timeout',
    });
  }

  return timedOut.length;
}

/**
 * @deprecated Use recoverStaleExecutions instead
 */
export const recoverStaleWorkUnits = recoverStaleExecutions;

/**
 * 孤儿恢复：检查 running GoalExecution 的 worktree 状态
 * - worktree 不存在 → mark failed
 * - .progress.json allComplete → mark succeeded
 * - 否则 → re-queue with resumeAfterRestart
 * @returns 恢复数量
 */
export async function recoverOrphanedExecutions(): Promise<number> {
  try {
    const stale = await prisma.goalExecution.findMany({
      where: { status: 'running' },
      select: { id: true, input: true },
    });

    if (stale.length === 0) return 0;

    logger.info('[StaleRecovery] Recovering stale executions', { count: stale.length });
    let recovered = 0;

    for (const exec of stale) {
      const worktree = path.join(WORKTREES_DIR, exec.id);
      try {
        if (fs.existsSync(worktree)) {
          const progressPath = path.join(worktree, '.progress.json');
          let allComplete = false;
          if (fs.existsSync(progressPath)) {
            const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
            allComplete = progress.allComplete === true;
          }

          if (allComplete) {
            await goalService.updateStepExecution(exec.id, { status: 'succeeded' });
            logger.info('[StaleRecovery] Marked succeeded', { executionId: exec.id });
          } else {
            let parsedInput: Record<string, unknown> = {};
            if (exec.input) {
              try { parsedInput = JSON.parse(exec.input); } catch { parsedInput = {}; }
            }
            await goalService.updateStepExecution(exec.id, {
              status: 'pending',
              input: JSON.stringify({
                ...(parsedInput as Record<string, unknown>),
                resumeAfterRestart: true,
              }),
            });
            logger.info('[StaleRecovery] Re-queued for retry', { executionId: exec.id });
          }
          recovered++;
        } else {
          await goalService.updateStepExecution(exec.id, {
            status: 'failed',
            error: 'Worktree lost after service restart',
          });
          logger.warn('[StaleRecovery] Worktree lost, marked failed', { executionId: exec.id });
          recovered++;
        }
      } catch (e) {
        logger.error('[StaleRecovery] Error recovering execution', { executionId: exec.id, error: String(e) });
        await goalService.updateStepExecution(exec.id, {
          status: 'failed',
          error: `Recovery error: ${String(e)}`,
        }).catch((dbErr) => {
          logger.error('[StaleRecovery] Failed to persist failed status', {
            executionId: exec.id, dbError: String(dbErr),
          });
        });
      }
    }

    return recovered;
  } catch (e) {
    logger.error('[StaleRecovery] Error in recoverOrphanedExecutions', { error: String(e) });
    return 0;
  }
}
