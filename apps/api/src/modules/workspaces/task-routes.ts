/**
 * Task Routes — AS-020 P5: UI/Server task management
 *
 * Endpoints (JWT auth):
 *   POST   /api/v1/workspaces/:id/tasks               — Create task (status=pending)
 *   GET    /api/v1/workspaces/:id/tasks/:taskId        — Get task status + events
 *   POST   /api/v1/workspaces/:id/tasks/:taskId/cancel — Cancel task
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

// ─── POST /api/v1/workspaces/:id/tasks ───
// Create a new task (admin/UI creates, Daemon claims)

router.post('/:id/tasks', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id: workspaceId } = req.params;
    const { path, prompt, agent, modelTier, runtimeId, parentGoalId } = req.body;

    if (!path || typeof path !== 'string') {
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
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    // If runtimeId provided, verify it exists
    if (runtimeId) {
      const runtime = await prisma.workspaceRuntime.findFirst({
        where: { id: runtimeId, workspaceId },
      });

      if (!runtime) {
        return res.status(404).json({
          error: 'Runtime not found',
          code: 'RUNTIME_NOT_FOUND',
        });
      }
    }

    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path,
        prompt,
        agent,
        modelTier: modelTier || 'standard',
        runtimeId: runtimeId || null,
        parentGoalId: parentGoalId || null,
        status: 'pending',
      },
    });

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

    const task = await prisma.workspaceTask.findFirst({
      where: { id: taskId, workspaceId },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    const events = await prisma.workspaceEvent.findMany({
      where: { taskId, workspaceId },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      success: true,
      task,
      events,
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

    const task = await prisma.workspaceTask.findFirst({
      where: { id: taskId, workspaceId },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    // Can only cancel pending or running tasks
    if (task.status !== 'pending' && task.status !== 'running') {
      return res.status(409).json({
        error: `Task is ${task.status}, cannot cancel`,
        code: 'TASK_INVALID_STATUS',
      });
    }

    const updated = await prisma.workspaceTask.update({
      where: { id: taskId },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    // Emit cancel event
    await prisma.workspaceEvent.create({
      data: {
        workspaceId,
        taskId,
        type: 'done',
        content: 'Task cancelled by user',
      },
    });

    logger.info({ taskId, workspaceId }, '[Task] Cancelled');

    return res.json({ success: true, task: updated });
  } catch (error) {
    logger.error({ error }, '[Task] Cancel failed');
    return res.status(500).json({
      error: 'Failed to cancel task',
      code: 'TASK_CANCEL_ERROR',
    });
  }
});

export default router;
