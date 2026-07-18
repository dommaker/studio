/**
 * Daemon Routes — AS-020 P5: HTTP Claim + Event Reporting
 *
 * Storage:
 *   - Task: ~/.studio/workspaces/{id}/tasks.jsonl (JSONL)
 *   - Event: ~/.studio/workspaces/{id}/events.jsonl (JSONL)
 *
 * Endpoints (workspaceAuth — Bearer st_mach_xxx):
 *   POST /api/v1/daemon/tasks/claim        — Pull next pending task
 *   POST /api/v1/daemon/tasks/:id/messages — Report output/tool_use/error events
 *   POST /api/v1/daemon/tasks/:id/complete — Mark task done
 *   POST /api/v1/daemon/tasks/:id/fail     — Mark task error
 *   POST /api/v1/daemon/tasks/:id/session  — Update session/workDir (Session Pinning)
 *   GET  /api/v1/daemon/tasks/:id/status   — Poll task status (cancel detection)
 */

import { Router, Request, Response } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { workspaceAuth, AuthRequest } from '../../middleware/auth.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');
const router = Router();

// ── Task & Event helpers ──

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
  await fs.promises.mkdir(path.dirname(tasksPath(workspaceId)), { recursive: true });
  await fileStore.writeJsonl(tasksPath(workspaceId), tasks);
}

async function appendEvent(workspaceId: string, event: Record<string, any>): Promise<void> {
  await fs.promises.mkdir(path.dirname(eventsPath(workspaceId)), { recursive: true });
  await fileStore.appendJsonl(eventsPath(workspaceId), event);
}

async function appendEvents(workspaceId: string, events: Record<string, any>[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(eventsPath(workspaceId)), { recursive: true });
  for (const evt of events) {
    await fileStore.appendJsonl(eventsPath(workspaceId), evt);
  }
}

// ─── POST /api/v1/daemon/tasks/claim ───
// Pull next pending task for this workspace (optionally filtered by runtime_id)

router.post('/tasks/claim', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { runtime_id } = req.body;

    const tasks = await readTasks(workspace.id);

    // Find oldest pending task
    const candidates = tasks.filter(t => {
      if (t.status !== 'pending') return false;
      if (runtime_id && t.runtimeId && t.runtimeId !== runtime_id) return false;
      return true;
    });
    candidates.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const task = candidates[0];
    if (!task) {
      return res.status(204).send();
    }

    // Double-check still pending (for concurrent access simulation)
    if (task.status !== 'pending') {
      return res.status(204).send();
    }

    // Claim: update status to running
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx < 0) return res.status(204).send();
    tasks[idx].status = 'running';
    tasks[idx].runtimeId = runtime_id || task.runtimeId;
    tasks[idx].updatedAt = new Date().toISOString();
    await writeTasks(workspace.id, tasks);

    logger.info({ taskId: task.id, workspaceId: workspace.id, runtimeId: runtime_id }, '[Daemon] Task claimed');

    return res.json({ task: tasks[idx] });
  } catch (error) {
    logger.error({ error }, '[Daemon] Claim failed');
    return res.status(500).json({
      error: 'Task claim failed',
      code: 'DAEMON_CLAIM_ERROR',
    });
  }
});

// ─── POST /api/v1/daemon/tasks/:id/messages ───

router.post('/tasks/:id/messages', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'messages array is required',
        code: 'MISSING_MESSAGES',
      });
    }

    // Verify task exists
    const tasks = await readTasks(workspace.id);
    const task = tasks.find(t => t.id === id);
    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    // Batch append events
    const events = messages.map((msg: { seq?: number; type: string; content: string; tool?: string; input?: string }) => ({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      workspaceId: workspace.id,
      taskId: id,
      type: msg.type,
      content: msg.content,
      metadata: JSON.stringify({
        seq: msg.seq,
        tool: msg.tool,
        input: msg.input,
      }),
      createdAt: new Date().toISOString(),
    }));

    await appendEvents(workspace.id, events);

    logger.debug({ taskId: id, count: events.length }, '[Daemon] Messages recorded');

    return res.json({ success: true, recorded: events.length });
  } catch (error) {
    logger.error({ error }, '[Daemon] Messages failed');
    return res.status(500).json({
      error: 'Failed to record messages',
      code: 'DAEMON_MESSAGES_ERROR',
    });
  }
});

// ─── POST /api/v1/daemon/tasks/:id/complete ───

router.post('/tasks/:id/complete', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;
    const { output, session_id, work_dir } = req.body;

    const tasks = await readTasks(workspace.id);
    const idx = tasks.findIndex(t => t.id === id);

    if (idx < 0) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    if (tasks[idx].status !== 'running') {
      return res.status(409).json({
        error: `Task is ${tasks[idx].status}, cannot complete`,
        code: 'TASK_INVALID_STATUS',
      });
    }

    const now = new Date().toISOString();
    const elapsedMs = Date.now() - new Date(tasks[idx].createdAt).getTime();

    tasks[idx].status = 'done';
    tasks[idx].result = JSON.stringify({ output, elapsedMs });
    tasks[idx].sessionId = session_id || tasks[idx].sessionId;
    tasks[idx].workDir = work_dir || tasks[idx].workDir;
    tasks[idx].completedAt = now;
    tasks[idx].updatedAt = now;

    await writeTasks(workspace.id, tasks);

    // Emit done event
    await appendEvent(workspace.id, {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      workspaceId: workspace.id,
      taskId: id,
      type: 'done',
      content: output || '',
      createdAt: now,
    });

    logger.info({ taskId: id, elapsedMs }, '[Daemon] Task completed');

    return res.json({ success: true, task: tasks[idx] });
  } catch (error) {
    logger.error({ error }, '[Daemon] Complete failed');
    return res.status(500).json({
      error: 'Failed to complete task',
      code: 'DAEMON_COMPLETE_ERROR',
    });
  }
});

// ─── POST /api/v1/daemon/tasks/:id/fail ───

router.post('/tasks/:id/fail', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;
    const { error: taskError, session_id, work_dir, failure_reason } = req.body;

    const tasks = await readTasks(workspace.id);
    const idx = tasks.findIndex(t => t.id === id);

    if (idx < 0) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    if (tasks[idx].status !== 'running') {
      return res.status(409).json({
        error: `Task is ${tasks[idx].status}, cannot fail`,
        code: 'TASK_INVALID_STATUS',
      });
    }

    const now = new Date().toISOString();
    const elapsedMs = Date.now() - new Date(tasks[idx].createdAt).getTime();

    tasks[idx].status = 'error';
    tasks[idx].result = JSON.stringify({ error: taskError, failureReason: failure_reason, elapsedMs });
    tasks[idx].sessionId = session_id || tasks[idx].sessionId;
    tasks[idx].workDir = work_dir || tasks[idx].workDir;
    tasks[idx].completedAt = now;
    tasks[idx].updatedAt = now;

    await writeTasks(workspace.id, tasks);

    // Emit error event
    await appendEvent(workspace.id, {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      workspaceId: workspace.id,
      taskId: id,
      type: 'error',
      content: taskError || 'Unknown error',
      createdAt: now,
    });

    logger.info({ taskId: id, failureReason: failure_reason }, '[Daemon] Task failed');

    return res.json({ success: true, task: tasks[idx] });
  } catch (error) {
    logger.error({ error }, '[Daemon] Fail failed');
    return res.status(500).json({
      error: 'Failed to mark task as failed',
      code: 'DAEMON_FAIL_ERROR',
    });
  }
});

// ─── POST /api/v1/daemon/tasks/:id/session ───
// Update session/workDir (Session Pinning)

router.post('/tasks/:id/session', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;
    const { session_id, work_dir } = req.body;

    if (!session_id && !work_dir) {
      return res.status(400).json({
        error: 'session_id or work_dir required',
        code: 'MISSING_SESSION_DATA',
      });
    }

    const tasks = await readTasks(workspace.id);
    const idx = tasks.findIndex(t => t.id === id);

    if (idx < 0) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    tasks[idx].sessionId = session_id || tasks[idx].sessionId;
    tasks[idx].workDir = work_dir || tasks[idx].workDir;
    tasks[idx].updatedAt = new Date().toISOString();

    await writeTasks(workspace.id, tasks);

    logger.debug({ taskId: id }, '[Daemon] Session pinned');

    return res.json({ success: true, task: tasks[idx] });
  } catch (error) {
    logger.error({ error }, '[Daemon] Session update failed');
    return res.status(500).json({
      error: 'Failed to update session',
      code: 'DAEMON_SESSION_ERROR',
    });
  }
});

// ─── GET /api/v1/daemon/tasks/:id/status ───
// Poll task status (cancel detection — Daemon polls every 5s)

router.get('/tasks/:id/status', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;

    const tasks = await readTasks(workspace.id);
    const task = tasks.find(t => t.id === id);

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    return res.json({
      status: task.status,
      result: task.result ? JSON.parse(task.result) : null,
      completedAt: task.completedAt || null,
    });
  } catch (error) {
    logger.error({ error }, '[Daemon] Status poll failed');
    return res.status(500).json({
      error: 'Failed to get task status',
      code: 'DAEMON_STATUS_ERROR',
    });
  }
});

// ─── GET /api/v1/daemon/status ───
// Daemon session status (for CLI and monitoring)

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const { daemon } = await import('../../daemon/studio-daemon.js');
    if (!daemon.isStarted()) {
      return res.json({ started: false, sessions: [] });
    }
    const statuses = daemon.getStatus() as Array<{
      name: string; isBusy: boolean; lastUsed: number; taskCount: number; worktree: string; persistent: boolean;
    } | null>;
    return res.json({
      started: true,
      sessions: (statuses || []).filter(Boolean),
    });
  } catch (error) {
    logger.error({ error }, '[Daemon] Status query failed');
    return res.status(500).json({
      error: 'Failed to get daemon status',
      code: 'DAEMON_STATUS_ERROR',
    });
  }
});

export default router;
