/**
 * Workspace Routes — AS-020 P2: Workspace registration + heartbeat + token management
 *
 * Storage: ~/.studio/workspaces/{id}.json (merged JSON with nested tokens/runtimes/repos)
 *
 * Endpoints:
 *   POST   /api/v1/workspaces/register     — Daemon registration (token auth)
 *   PUT    /api/v1/workspaces/:id/heartbeat — Daemon heartbeat (token auth)
 *   GET    /api/v1/workspaces               — List workspaces (JWT auth)
 *   DELETE /api/v1/workspaces/:id           — Delete workspace (JWT auth)
 */

import { Router, Request, Response } from 'express';
import { FileStore, generateId } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { requireAuth, requireAdmin, workspaceAuth, AuthRequest } from '../../middleware/auth.js';
import discoverProxyRouter from './discover-proxy.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');
const router = Router();

// Mount discover proxy (P4: WS-backed directory discovery)
router.use('/', discoverProxyRouter);

// ── Workspace data helpers ──

async function ensureWorkspacesDir(): Promise<void> {
  await fs.promises.mkdir(WORKSPACES_DIR, { recursive: true });
}

function wsPath(id: string): string {
  return path.join(WORKSPACES_DIR, `${id}.json`);
}

async function readWorkspace(id: string): Promise<Record<string, any> | null> {
  return fileStore.readJson<Record<string, any>>(wsPath(id));
}

async function writeWorkspace(id: string, data: Record<string, any>): Promise<void> {
  await ensureWorkspacesDir();
  await fileStore.writeJson(wsPath(id), data);
}

async function listWorkspaces(): Promise<Record<string, any>[]> {
  await ensureWorkspacesDir();
  const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
  const results: Record<string, any>[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const data = await fileStore.readJson<Record<string, any>>(path.join(WORKSPACES_DIR, e.name));
    if (data) results.push(data);
  }
  results.sort((a, b) => {
    const da = new Date((a.createdAt as string) || 0).getTime();
    const db = new Date((b.createdAt as string) || 0).getTime();
    return db - da;
  });
  return results;
}

async function deleteWorkspaceDir(id: string): Promise<void> {
  const tasksDir = path.join(WORKSPACES_DIR, id);
  const eventsPath = path.join(tasksDir, 'events.jsonl');
  const tasksPath = path.join(tasksDir, 'tasks.jsonl');
  // Clean up task/event files
  try { await fs.promises.unlink(eventsPath); } catch { /* not exist */ }
  try { await fs.promises.unlink(tasksPath); } catch { /* not exist */ }
  try { await fs.promises.rmdir(tasksDir); } catch { /* not empty or not exist */ }
  // Delete workspace file
  try { await fs.promises.unlink(wsPath(id)); } catch { /* not exist */ }
}

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
      os: wsOs,
      arch,
      repos = [],
    } = req.body;

    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      return res.status(400).json({
        error: 'workspaceRoot is required',
        code: 'MISSING_WORKSPACE_ROOT',
      });
    }

    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: Record<string, any> = existingWorkspace as any;
    const workspace: Record<string, any> = {
      id: existing.id,
      name: name || existing.name || 'Unnamed',
      workspaceRoot,
      hasDocker: hasDocker ?? existing.hasDocker ?? false,
      os: wsOs || existing.os || null,
      arch: arch || existing.arch || null,
      status: 'idle',
      lastHeartbeat: now,
      currentTask: existing.currentTask || null,
      tokenId: existing.tokenId || workspaceToken.id || null,
      tokens: existing.tokens || [],
      runtimes: [...(existing.runtimes || [])],
      repos: [...(existing.repos || [])],
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };

    // Upsert runtimes
    if (Array.isArray(runtimes) && runtimes.length > 0) {
      const wsruntimes = workspace.runtimes as any[];
      for (const rt of runtimes) {
        if (!rt.provider) continue;
        const idx = wsruntimes.findIndex((r: any) => r.provider === rt.provider);
        const rtData = {
          id: `${workspace.id}_${rt.provider}`,
          provider: rt.provider,
          name: rt.name || rt.provider,
          version: rt.version || null,
          status: 'online',
          lastSeenAt: now,
          createdAt: idx >= 0 ? wsruntimes[idx].createdAt : now,
          updatedAt: now,
        };
        if (idx >= 0) {
          wsruntimes[idx] = { ...wsruntimes[idx], ...rtData, id: wsruntimes[idx].id };
        } else {
          wsruntimes.push(rtData);
        }
      }
    }

    // Upsert repos (AS-023)
    let repoCount = 0;
    if (Array.isArray(repos) && repos.length > 0) {
      const wsrepos = workspace.repos as any[];
      for (const repo of repos) {
        if (!repo.path || !repo.name) continue;
        const idx = wsrepos.findIndex((r: any) => r.path === repo.path);
        const repoData = {
          id: idx >= 0 ? wsrepos[idx].id : generateId('wr'),
          path: repo.path,
          name: repo.name,
          category: repo.category || null,
          description: repo.description || null,
          defaultBranch: repo.defaultBranch || 'main',
          remoteUrl: repo.remoteUrl || null,
          status: 'active',
          lastSyncedAt: now,
          createdAt: idx >= 0 ? wsrepos[idx].createdAt : now,
        };
        if (idx >= 0) {
          wsrepos[idx] = { ...wsrepos[idx], ...repoData, id: wsrepos[idx].id };
        } else {
          wsrepos.push(repoData);
        }
        repoCount++;
      }

      // Mark repos no longer reported as unavailable
      const reportedPaths = new Set(repos.map((r: any) => r.path));
      for (const existing of wsrepos) {
        if (!reportedPaths.has(existing.path) && existing.status === 'active') {
          existing.status = 'unavailable';
        }
      }
    }

    await writeWorkspace(workspace.id as string, workspace);

    logger.info({ workspaceId: workspace.id, name: workspace.name, runtimeCount: (runtimes as any[]).length, repoCount }, '[Workspace] Registered');

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

    if (workspace.id !== id) {
      return res.status(403).json({
        error: 'Token does not match requested workspace',
        code: 'WORKSPACE_MISMATCH',
      });
    }

    const { status, currentTask } = req.body;
    const now = new Date().toISOString();

    const ws = await readWorkspace(id);
    if (!ws) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    ws.status = status || workspace.status;
    ws.currentTask = currentTask !== undefined ? currentTask : workspace.currentTask;
    ws.lastHeartbeat = now;
    ws.updatedAt = now;

    await writeWorkspace(id, ws);

    return res.json({
      success: true,
      data: {
        workspaceId: id,
        status: ws.status,
        lastHeartbeat: ws.lastHeartbeat,
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
// List all workspaces (JWT auth)

router.get('/', requireAuth(), requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const workspaces = await listWorkspaces();

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

router.delete('/:id', requireAuth(), requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const workspace = await readWorkspace(id);
    if (!workspace) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    await deleteWorkspaceDir(id);

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

router.get('/:id/runtimes', requireAuth(), requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const workspace = await readWorkspace(id);
    if (!workspace) {
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    const runtimes = (workspace.runtimes as any[] || []).sort((a, b) =>
      (a.provider as string).localeCompare(b.provider as string),
    );

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

// ─── GET /api/v1/workspaces/:id ───

router.get('/runtimes', requireAuth(), requireAdmin(), async (_req: Request, res: Response) => {
  try {
    // AC-2.6: 聚合所有 workspace 的 runtimes，供前端角色初始化向导使用
    // 2026-07：聚合前先重扫本地 CLI（best-effort），保证本地 runtime 新鲜可见
    const { rescanLocalRuntimes } = await import('./local-workspace.js');
    await rescanLocalRuntimes().catch(() => {});

    const workspaces = await listWorkspaces();
    const allRuntimes: Array<{ nodeId: string; provider: string; version: string; workspaceName: string }> = [];
    for (const ws of workspaces) {
      const runtimes = (ws.runtimes as Array<{ provider: string; version: string }> | undefined) ?? [];
      for (const rt of runtimes) {
        allRuntimes.push({
          nodeId: ws.id,
          provider: rt.provider,
          version: rt.version,
          workspaceName: ws.name ?? ws.id,
        });
      }
    }
    return res.json({ runtimes: allRuntimes });
  } catch (error) {
    logger.error({ error }, '[Workspace] List all runtimes failed');
    return res.status(500).json({ error: 'Failed to list runtimes', code: 'WORKSPACE_RUNTIMES_ERROR' });
  }
});

router.get('/:id', requireAuth(), requireAdmin(), async (req: Request, res: Response) => {
  try {
    const workspace = await readWorkspace(req.params.id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    return res.json({ success: true, data: workspace });
  } catch (error) {
    logger.error({ error }, '[Workspace] Get failed');
    return res.status(500).json({ error: 'Failed to fetch workspace', code: 'WORKSPACE_GET_ERROR' });
  }
});

export default router;
