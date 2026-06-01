/**
 * GC Service — AS-020 P5: Garbage collection for old tasks and events
 *
 * Runs every 1h via setInterval:
 *   - done/error/cancelled tasks older than 24h → delete + cleanup events
 *   - running tasks with no heartbeat for 72h → mark error (orphan recovery)
 *   - WorkspaceEvent older than 24h for completed tasks → delete
 */

import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

const GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DONE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ORPHAN_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let gcTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run one GC cycle. Exported for testing.
 */
export async function runGC(): Promise<{
  deletedTasks: number;
  orphanedTasks: number;
  deletedEvents: number;
}> {
  const now = new Date();
  let deletedTasks = 0;
  let orphanedTasks = 0;
  let deletedEvents = 0;

  try {
    // 1. Delete completed/errored/cancelled tasks older than 24h
    const doneThreshold = new Date(now.getTime() - DONE_TTL_MS);
    const oldTasks = await prisma.workspaceTask.findMany({
      where: {
        status: { in: ['done', 'error', 'cancelled'] },
        completedAt: { lt: doneThreshold },
      },
      select: { id: true, workspaceId: true },
    });

    if (oldTasks.length > 0) {
      // Delete events for these tasks first
      for (const task of oldTasks) {
        await prisma.workspaceEvent.deleteMany({ where: { taskId: task.id } });
      }

      const { count } = await prisma.workspaceTask.deleteMany({
        where: {
          id: { in: oldTasks.map(t => t.id) },
        },
      });
      deletedTasks = count;
    }

    // 2. Mark orphaned running tasks (no update for 72h) as error
    const orphanThreshold = new Date(now.getTime() - ORPHAN_TTL_MS);
    const orphaned = await prisma.workspaceTask.updateMany({
      where: {
        status: 'running',
        updatedAt: { lt: orphanThreshold },
      },
      data: {
        status: 'error',
        result: JSON.stringify({
          error: 'Orphaned: no heartbeat for 72h',
          failureReason: 'orphan_timeout',
        }),
        completedAt: now,
      },
    });
    orphanedTasks = orphaned.count;

    // 3. Delete old events for completed tasks (keep events for active tasks)
    const eventThreshold = new Date(now.getTime() - EVENT_TTL_MS);

    // Find completed task IDs
    const completedTaskIds = await prisma.workspaceTask.findMany({
      where: {
        status: { in: ['done', 'error', 'cancelled'] },
        completedAt: { not: null },
      },
      select: { id: true },
    });

    if (completedTaskIds.length > 0) {
      const { count } = await prisma.workspaceEvent.deleteMany({
        where: {
          taskId: { in: completedTaskIds.map(t => t.id) },
          createdAt: { lt: eventThreshold },
        },
      });
      deletedEvents = count;
    }

    if (deletedTasks > 0 || orphanedTasks > 0 || deletedEvents > 0) {
      logger.info(
        { deletedTasks, orphanedTasks, deletedEvents },
        '[GC] Cycle completed',
      );
    }
  } catch (error) {
    logger.error({ error }, '[GC] Cycle failed');
  }

  return { deletedTasks, orphanedTasks, deletedEvents };
}

/**
 * Start the GC interval. Call once at app startup.
 */
export function startGC(): void {
  if (gcTimer) return;

  gcTimer = setInterval(runGC, GC_INTERVAL_MS);

  // Run immediately on start
  runGC().catch(err => {
    logger.error({ err }, '[GC] Initial run failed');
  });

  logger.info({ intervalMs: GC_INTERVAL_MS }, '[GC] Started');
}

/**
 * Stop the GC interval. For graceful shutdown.
 */
export function stopGC(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
    logger.info('[GC] Stopped');
  }
}
