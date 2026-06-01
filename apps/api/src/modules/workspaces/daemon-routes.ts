/**
 * Daemon Routes — AS-020 P5: HTTP Claim + Event Reporting
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
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';
import { workspaceAuth, AuthRequest } from '../../middleware/auth.js';

const router = Router();

// ─── POST /api/v1/daemon/tasks/claim ───
// Pull next pending task for this workspace (optionally filtered by runtime_id)

router.post('/tasks/claim', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { runtime_id } = req.body;

    // Find pending task: match runtime_id if provided, otherwise any runtime or null
    const where: Record<string, unknown> = {
      workspaceId: workspace.id,
      status: 'pending',
    };

    if (runtime_id) {
      where.runtimeId = runtime_id;
    }

    const task = await prisma.workspaceTask.findFirst({
      where,
      orderBy: { createdAt: 'asc' },
    });

    if (!task) {
      return res.status(204).send();
    }

    // Atomically claim: update status to running only if still pending
    const claimed = await prisma.workspaceTask.updateMany({
      where: {
        id: task.id,
        status: 'pending',
      },
      data: {
        status: 'running',
        runtimeId: runtime_id || task.runtimeId,
      },
    });

    if (claimed.count === 0) {
      // Race condition: another daemon claimed it
      return res.status(204).send();
    }

    const fullTask = await prisma.workspaceTask.findUnique({
      where: { id: task.id },
    });

    logger.info({ taskId: task.id, workspaceId: workspace.id, runtimeId: runtime_id }, '[Daemon] Task claimed');

    return res.json({ task: fullTask });
  } catch (error) {
    logger.error({ error }, '[Daemon] Claim failed');
    return res.status(500).json({
      error: 'Task claim failed',
      code: 'DAEMON_CLAIM_ERROR',
    });
  }
});

// ─── POST /api/v1/daemon/tasks/:id/messages ───
// Report batched output/tool_use/error events

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

    // Verify task exists and belongs to this workspace
    const task = await prisma.workspaceTask.findFirst({
      where: { id, workspaceId: workspace.id },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    // Batch insert events
    const events = messages.map((msg: { seq?: number; type: string; content: string; tool?: string; input?: string }) => ({
      workspaceId: workspace.id,
      taskId: id,
      type: msg.type,
      content: msg.content,
      metadata: JSON.stringify({
        seq: msg.seq,
        tool: msg.tool,
        input: msg.input,
      }),
    }));

    await prisma.workspaceEvent.createMany({ data: events });

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
// Mark task done with output

router.post('/tasks/:id/complete', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;
    const { output, session_id, work_dir } = req.body;

    const task = await prisma.workspaceTask.findFirst({
      where: { id, workspaceId: workspace.id },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    if (task.status !== 'running') {
      return res.status(409).json({
        error: `Task is ${task.status}, cannot complete`,
        code: 'TASK_INVALID_STATUS',
      });
    }

    const now = new Date();
    const elapsedMs = now.getTime() - task.createdAt.getTime();

    const result = JSON.stringify({
      output,
      elapsedMs,
    });

    const updated = await prisma.workspaceTask.update({
      where: { id },
      data: {
        status: 'done',
        result,
        sessionId: session_id || task.sessionId,
        workDir: work_dir || task.workDir,
        completedAt: now,
      },
    });

    // Emit done event
    await prisma.workspaceEvent.create({
      data: {
        workspaceId: workspace.id,
        taskId: id,
        type: 'done',
        content: output || '',
      },
    });

    logger.info({ taskId: id, elapsedMs }, '[Daemon] Task completed');

    return res.json({ success: true, task: updated });
  } catch (error) {
    logger.error({ error }, '[Daemon] Complete failed');
    return res.status(500).json({
      error: 'Failed to complete task',
      code: 'DAEMON_COMPLETE_ERROR',
    });
  }
});

// ─── POST /api/v1/daemon/tasks/:id/fail ───
// Mark task error

router.post('/tasks/:id/fail', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;
    const { error: taskError, session_id, work_dir, failure_reason } = req.body;

    const task = await prisma.workspaceTask.findFirst({
      where: { id, workspaceId: workspace.id },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    if (task.status !== 'running') {
      return res.status(409).json({
        error: `Task is ${task.status}, cannot fail`,
        code: 'TASK_INVALID_STATUS',
      });
    }

    const now = new Date();
    const elapsedMs = now.getTime() - task.createdAt.getTime();

    const result = JSON.stringify({
      error: taskError,
      failureReason: failure_reason,
      elapsedMs,
    });

    const updated = await prisma.workspaceTask.update({
      where: { id },
      data: {
        status: 'error',
        result,
        sessionId: session_id || task.sessionId,
        workDir: work_dir || task.workDir,
        completedAt: now,
      },
    });

    // Emit error event
    await prisma.workspaceEvent.create({
      data: {
        workspaceId: workspace.id,
        taskId: id,
        type: 'error',
        content: taskError || 'Unknown error',
      },
    });

    logger.info({ taskId: id, failureReason: failure_reason }, '[Daemon] Task failed');

    return res.json({ success: true, task: updated });
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

    const task = await prisma.workspaceTask.findFirst({
      where: { id, workspaceId: workspace.id },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    const updated = await prisma.workspaceTask.update({
      where: { id },
      data: {
        sessionId: session_id || task.sessionId,
        workDir: work_dir || task.workDir,
      },
    });

    logger.debug({ taskId: id }, '[Daemon] Session pinned');

    return res.json({ success: true, task: updated });
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

    const task = await prisma.workspaceTask.findFirst({
      where: { id, workspaceId: workspace.id },
      select: { id: true, status: true, result: true, completedAt: true },
    });

    if (!task) {
      return res.status(404).json({
        error: 'Task not found',
        code: 'TASK_NOT_FOUND',
      });
    }

    return res.json({
      status: task.status,
      result: task.result ? JSON.parse(task.result) : null,
      completedAt: task.completedAt,
    });
  } catch (error) {
    logger.error({ error }, '[Daemon] Status poll failed');
    return res.status(500).json({
      error: 'Failed to get task status',
      code: 'DAEMON_STATUS_ERROR',
    });
  }
});

export default router;
