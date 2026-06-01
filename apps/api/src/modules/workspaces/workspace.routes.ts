/**
 * Workspace Routes — AS-020 P2: Workspace registration + heartbeat + token management
 *
 * Endpoints:
 *   POST   /api/v1/workspaces/register     — Daemon registration (token auth)
 *   PUT    /api/v1/workspaces/:id/heartbeat — Daemon heartbeat (token auth)
 *   GET    /api/v1/workspaces               — List workspaces (JWT auth)
 *   DELETE /api/v1/workspaces/:id           — Delete workspace (JWT auth)
 *
 *   POST   /api/v1/workspace-tokens         — Generate token (JWT auth)
 *   GET    /api/v1/workspace-tokens         — List tokens (JWT auth)
 *   DELETE /api/v1/workspace-tokens/:id     — Revoke token (JWT auth)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, workspaceAuth, AuthRequest } from '../../middleware/auth.js';
import discoverProxyRouter from './discover-proxy.js';

const router = Router();

// Mount discover proxy (P4: WS-backed directory discovery)
router.use('/', discoverProxyRouter);

// ─── POST /api/v1/workspaces/register ───
// Daemon registration with workspace token auth

router.post('/register', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspaceToken = authReq.workspaceToken!;
    const existingWorkspace = authReq.workspace!;

    const {
      name,
      workspaceRoot,
      runtimes = [],
      hasDocker = false,
      os,
      arch,
    } = req.body;

    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      return res.status(400).json({
        error: 'workspaceRoot is required',
        code: 'MISSING_WORKSPACE_ROOT',
      });
    }

    // Update or create workspace (same token → update, not duplicate)
    const workspace = await prisma.workspace.upsert({
      where: { id: existingWorkspace.id },
      update: {
        name: name || existingWorkspace.name,
        workspaceRoot,
        hasDocker,
        os: os || null,
        arch: arch || null,
        status: 'idle',
        lastHeartbeat: new Date(),
      },
      create: {
        name: name || 'Unnamed',
        tokenId: workspaceToken.id,
        workspaceRoot,
        hasDocker,
        os: os || null,
        arch: arch || null,
        status: 'idle',
        lastHeartbeat: new Date(),
      },
    });

    // Create/update WorkspaceRuntime records
    if (Array.isArray(runtimes) && runtimes.length > 0) {
      for (const rt of runtimes) {
        if (!rt.provider) continue;
        await prisma.workspaceRuntime.upsert({
          where: {
            workspaceId_provider: {
              workspaceId: workspace.id,
              provider: rt.provider,
            },
          },
          update: {
            name: rt.name || rt.provider,
            version: rt.version || null,
            status: 'online',
            lastSeenAt: new Date(),
          },
          create: {
            workspaceId: workspace.id,
            provider: rt.provider,
            name: rt.name || rt.provider,
            version: rt.version || null,
            status: 'online',
            lastSeenAt: new Date(),
          },
        });
      }
    }

    logger.info({ workspaceId: workspace.id, name: workspace.name, runtimeCount: runtimes.length }, '[Workspace] Registered');

    return res.json({
      success: true,
      data: {
        workspaceId: workspace.id,
        name: workspace.name,
        status: workspace.status,
      },
    });
  } catch (error) {
    logger.error({ error }, '[Workspace] Registration failed');
    return res.status(500).json({
      error: 'Workspace registration failed',
      code: 'WORKSPACE_REGISTER_ERROR',
    });
  }
});

// ─── PUT /api/v1/workspaces/:id/heartbeat ───

router.put('/:id/heartbeat', workspaceAuth(), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const workspace = authReq.workspace!;
    const { id } = req.params;

    // Ensure the authenticated workspace matches the requested workspace
    if (workspace.id !== id) {
      return res.status(403).json({
        error: 'Token does not match requested workspace',
        code: 'WORKSPACE_MISMATCH',
      });
    }

    const { status, currentTask } = req.body;

    const updated = await prisma.workspace.update({
      where: { id },
      data: {
        status: status || workspace.status,
        currentTask: currentTask !== undefined ? currentTask : workspace.currentTask,
        lastHeartbeat: new Date(),
      },
    });

    return res.json({
      success: true,
      data: {
        workspaceId: updated.id,
        status: updated.status,
        lastHeartbeat: updated.lastHeartbeat,
      },
    });
  } catch (error) {
    logger.error({ error }, '[Workspace] Heartbeat failed');
    return res.status(500).json({
      error: 'Heartbeat update failed',
      code: 'WORKSPACE_HEARTBEAT_ERROR',
    });
  }
});

// ─── GET /api/v1/workspaces ───
// List all workspaces with runtimes (JWT auth)

router.get('/', requireAuth(), async (_req: Request, res: Response) => {
  try {
    const workspaces = await prisma.workspace.findMany({
      include: {
        runtimes: true,
        _count: { select: { tasks: true, events: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      data: workspaces,
      total: workspaces.length,
    });
  } catch (error) {
    logger.error({ error }, '[Workspace] List failed');
    return res.status(500).json({
      error: 'Failed to list workspaces',
      code: 'WORKSPACE_LIST_ERROR',
    });
  }
});

// ─── DELETE /api/v1/workspaces/:id ───
// Delete workspace (cascades to runtimes, tasks, events)

router.delete('/:id', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    await prisma.workspace.delete({ where: { id } });

    logger.info({ workspaceId: id }, '[Workspace] Deleted');
    return res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    logger.error({ error }, '[Workspace] Delete failed');
    return res.status(500).json({
      error: 'Failed to delete workspace',
      code: 'WORKSPACE_DELETE_ERROR',
    });
  }
});

// ─── GET /api/v1/workspaces/:id/runtimes ───

router.get('/:id/runtimes', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const runtimes = await prisma.workspaceRuntime.findMany({
      where: { workspaceId: id },
      orderBy: { provider: 'asc' },
    });

    return res.json({
      success: true,
      data: runtimes,
      total: runtimes.length,
    });
  } catch (error) {
    logger.error({ error }, '[Workspace] List runtimes failed');
    return res.status(500).json({
      error: 'Failed to list runtimes',
      code: 'WORKSPACE_RUNTIMES_ERROR',
    });
  }
});

export default router;
