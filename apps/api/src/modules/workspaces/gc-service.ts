/**
 * GC Service — AS-020 P5: Garbage collection for old tasks and events
 *
 * Storage: ~/.studio/workspaces/{id}/tasks.jsonl + events.jsonl
 *
 * Runs every 1h via setInterval:
 *   - done/error/cancelled tasks older than 24h → delete + cleanup events
 *   - running tasks with no heartbeat for 72h → mark error (orphan recovery)
 *   - WorkspaceEvent older than 24h for completed tasks → delete
 */

import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');

const GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DONE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ORPHAN_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let gcTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──

async function getWorkspaceIds(): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function tasksPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId, 'tasks.jsonl');
}

function eventsPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId, 'events.jsonl');
}

async function readTasks(workspaceId: string): Promise<Record<string, any>[]> {
  return fileStore.readJsonl<Record<string, any>>(tasksPath(workspaceId));
}

async function writeTasks(workspaceId: string, tasks: Record<string, any>[]): Promise<void> {
  await fileStore.writeJsonl(tasksPath(workspaceId), tasks);
}

async function readEvents(workspaceId: string): Promise<Record<string, any>[]> {
  return fileStore.readJsonl<Record<string, any>>(eventsPath(workspaceId));
}

async function writeEvents(workspaceId: string, events: Record<string, any>[]): Promise<void> {
  await fileStore.writeJsonl(eventsPath(workspaceId), events);
}

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
    const workspaceIds = await getWorkspaceIds();

    for (const wid of workspaceIds) {
      let tasks = await readTasks(wid);
      let events = await readEvents(wid);
      let tasksChanged = false;
      let eventsChanged = false;

      // 1. Delete completed/errored/cancelled tasks older than 24h
      const doneThreshold = new Date(now.getTime() - DONE_TTL_MS);
      const oldTaskIds = tasks
        .filter(t =>
          ['done', 'error', 'cancelled'].includes(t.status) &&
          t.completedAt &&
          new Date(t.completedAt) < doneThreshold,
        )
        .map(t => t.id);

      if (oldTaskIds.length > 0) {
        // Delete events for these tasks
        const oldIdSet = new Set(oldTaskIds);
        events = events.filter(e => !oldIdSet.has(e.taskId));
        eventsChanged = true;
        deletedEvents += events.length;

        tasks = tasks.filter(t => !oldIdSet.has(t.id));
        tasksChanged = true;
        deletedTasks += oldTaskIds.length;
      }

      // 2. Mark orphaned running tasks (no update for 72h) as error
      const orphanThreshold = new Date(now.getTime() - ORPHAN_TTL_MS);
      for (const task of tasks) {
        if (task.status === 'running' && new Date(task.updatedAt) < orphanThreshold) {
          task.status = 'error';
          task.result = JSON.stringify({
            error: 'Orphaned: no heartbeat for 72h',
            failureReason: 'orphan_timeout',
          });
          task.completedAt = now.toISOString();
          task.updatedAt = now.toISOString();
          tasksChanged = true;
          orphanedTasks++;
        }
      }

      // 3. Delete old events for completed tasks
      const completedTaskIds = new Set(
        tasks
          .filter(t => ['done', 'error', 'cancelled'].includes(t.status) && t.completedAt)
          .map(t => t.id),
      );
      const eventThreshold = new Date(now.getTime() - EVENT_TTL_MS);
      const oldEventCount = events.filter(
        e => completedTaskIds.has(e.taskId) && new Date(e.createdAt) < eventThreshold,
      ).length;

      if (oldEventCount > 0) {
        events = events.filter(
          e => !(completedTaskIds.has(e.taskId) && new Date(e.createdAt) < eventThreshold),
        );
        eventsChanged = true;
        deletedEvents += oldEventCount;
      }

      if (tasksChanged) await writeTasks(wid, tasks);
      if (eventsChanged) await writeEvents(wid, events);
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
