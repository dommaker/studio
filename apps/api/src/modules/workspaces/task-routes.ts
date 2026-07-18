/**
 * Task Routes — AS-020 P5: UI/Server task management
 *
 * Storage:
 *   - Tasks: ~/.studio/workspaces/{id}/tasks.jsonl (JSONL)
 *   - Events: ~/.studio/workspaces/{id}/events.jsonl (JSONL)
 *
 * Endpoints (JWT auth):
 *   POST   /api/v1/workspaces/:id/tasks               — Create task (status=pending)
 *   GET    /api/v1/workspaces/:id/tasks/:taskId        — Get task status + events
 *   POST   /api/v1/workspaces/:id/tasks/:taskId/cancel — Cancel task
 */

import { Router, Request, Response } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');
const router = Router();

// ── Helpers ──

function tasksPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId, 'tasks.jsonl');
}

function eventsPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId, 'events.jsonl');
}

function wsPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, `${workspaceId}.json`);
}

async function readWorkspace(id: string): Promise<Record<string, any> | null> {
  return fileStore.readJson<Record<string, any>>(wsPath(id));
}

async function readTasks(workspaceId: string): Promise<Record<string, any>[]> {
  return fileStore.readJsonl<Record<string, any>>(tasksPath(workspaceId));
}

async function writeTasks(workspaceId: string, tasks: Record<string, any>[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(tasksPath(workspaceId)), { recursive: true });
  await fileStore.writeJsonl(tasksPath(workspaceId), tasks);
}

async function readEvents(workspaceId: string): Promise<Record<string, any>[]> {
  return fileStore.readJsonl<Record<string, any>>(eventsPath(workspaceId));
}

async function appendTask(workspaceId: string, task: Record<string, any>): Promise<void> {
  await fs.promises.mkdir(path.dirname(tasksPath(workspaceId)), { recursive: true });
  await fileStore.appendJsonl(tasksPath(workspaceId), task);
}

async function appendEvent(workspaceId: string, event: Record<string, any>): Promise<void> {
  await fs.promises.mkdir(path.dirname(eventsPath(workspaceId)), { recursive: true });
  await fileStore.appendJsonl(eventsPath(workspaceId), event);
}

// ─── POST /api/v1/workspaces/:id/tasks ───
// Create a new task (admin/UI creates, Daemon claims)

router.post('/:id/tasks', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id: workspaceId } = req.params;
    const { path: taskPath, prompt, agent, modelTier, runtimeId, parentGoalId } = req.body;

    if (!taskPath || typeof taskPath !== 'string') {
      return res.status(400).json({
        error: 'path is required',
        code: 'MISSING_PATH',
      });
    }

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'prompt is required',
        code: 'MISSING_PROMPT',
      });
    }

    if (!agent || typeof agent !== 'string') {
      return res.status(400).json({
        error: 'agent is required',
        code: 'MISSING_AGENT',
      });
    }

    // Verify workspace exists
    const workspace = await readWorkspace(workspaceId);
    if (!workspace) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    // If runtimeId provided, verify it exists in workspace runtimes
    if (runtimeId) {
      const runtimes = workspace.runtimes || [];
      const rt = runtimes.find((r: any) => r.id === runtimeId);
      if (!rt) {
        return res.status(404).json({
          error: 'Runtime not found',
          code: 'RUNTIME_NOT_FOUND',
        });
      }
    }

    const now = new Date().toISOString();
    const task = {
      id: `t_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      workspaceId,
      path: taskPath,
      prompt,
      agent,
      modelTier: modelTier || 'standard',
      runtimeId: runtimeId || null,
      parentGoalId: parentGoalId || null,
      status: 'pending',
      result: null,
      error: null,
      sessionId: null,
      workDir: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await appendTask(workspaceId, task);

    logger.info({ taskId: task.id, workspaceId, agent }, '[Task] Created');

    return res.status(201).json({ success: true, task });
  } catch (error) {
    logger.error({ error }, '[Task] Create failed');
    return res.status(500).json({
      error: 'Failed to create task',
      code: 'TASK_CREATE_ERROR',
    });
  }
});

// ─── GET /api/v1/workspaces/:id/tasks/:taskId ───
// Get task status + events

router.get('/:id/tasks/:taskId', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id: workspaceId, taskId } = req.params;

    const tasks = await readTasks(workspaceId);
    const task = tasks.find(t => t.id === taskId);

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    const events = await readEvents(workspaceId);
    const taskEvents = events
      .filter(e => e.taskId === taskId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return res.json({
      success: true,
      task,
      events: taskEvents,
    });
  } catch (error) {
    logger.error({ error }, '[Task] Get failed');
    return res.status(500).json({
      error: 'Failed to get task',
      code: 'TASK_GET_ERROR',
    });
  }
});

// ─── POST /api/v1/workspaces/:id/tasks/:taskId/cancel ───
// Cancel task (pending → cancelled, running → cancelled)

router.post('/:id/tasks/:taskId/cancel', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id: workspaceId, taskId } = req.params;

    const tasks = await readTasks(workspaceId);
    const idx = tasks.findIndex(t => t.id === taskId);

    if (idx < 0) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    // Can only cancel pending or running tasks
    if (tasks[idx].status !== 'pending' && tasks[idx].status !== 'running') {
      return res.status(409).json({
        error: `Task is ${tasks[idx].status}, cannot cancel`,
        code: 'TASK_INVALID_STATUS',
      });
    }

    const now = new Date().toISOString();
    tasks[idx].status = 'cancelled';
    tasks[idx].completedAt = now;
    tasks[idx].updatedAt = now;

    await writeTasks(workspaceId, tasks);

    // Emit cancel event
    await appendEvent(workspaceId, {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      workspaceId,
      taskId,
      type: 'done',
      content: 'Task cancelled by user',
      createdAt: now,
    });

    logger.info({ taskId, workspaceId }, '[Task] Cancelled');

    return res.json({ success: true, task: tasks[idx] });
  } catch (error) {
    logger.error({ error }, '[Task] Cancel failed');
    return res.status(500).json({
      error: 'Failed to cancel task',
      code: 'TASK_CANCEL_ERROR',
    });
  }
});

export default router;
