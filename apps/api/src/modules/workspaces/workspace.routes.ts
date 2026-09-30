/**
 * Workspace Routes — 本机 workspace 记录的只读与删除面
 *
 * Storage: ~/.studio/workspaces/{id}.json (merged JSON with nested tokens/runtimes/repos)
 *
 * Endpoints:
 *   GET    /api/v1/workspaces               — List workspaces (JWT auth)
 *   GET    /api/v1/workspaces/runtimes      — 本机 CLI 清单 (JWT auth)
 *   GET    /api/v1/workspaces/:id           — Get one (JWT auth)
 *   GET    /api/v1/workspaces/:id/runtimes  — List one workspace's runtimes (JWT auth)
 *   DELETE /api/v1/workspaces/:id           — Delete workspace (JWT auth)
 *
 * POST /register 与 PUT /:id/heartbeat 已随远程节点方向删除（2026-09-10，
 * 判死出处 bdaf0dd3 2026-08-04：无 daemon 客户端、无 WS 客户端、nodeId 无创建路径）。
 *
 * 契约驱动迁移（2026-10 批次 2/7）：全部端点走 core/http.ts defineRoute——
 * 统一 envelope（{ data }；原 `{ success, data, total }` 的 total 与平铺错误壳
 * `{ error: string, code }` 退役，404 走 HttpError NOT_FOUND，500 兜底统一 INTERNAL）。
 * 鉴权挂载保持原样（requireAuth/requireAdmin 声明式统一是 Phase 2 的事）。
 */

import { Router } from 'express';
import {
  workspaceIdParamsSchema,
  ERROR_CODES,
  type Workspace,
  type WorkspaceRuntime,
} from '@dommaker/studio-contract';

import { logger } from '../../utils/logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { apiCache } from '../../middleware/api-cache.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { resolveVpsWorkspace } from '@dommaker/studio-shared/node';
import { defineRoute, HttpError } from '../../core/http.js';
import { getStore } from '../../core/store.js';


const WORKSPACES_DIR = studioPath('workspaces');
const router = Router();

// ── Workspace data helpers ──

async function ensureWorkspacesDir(): Promise<void> {
  await fs.promises.mkdir(WORKSPACES_DIR, { recursive: true });
}

function wsPath(id: string): string {
  return path.join(WORKSPACES_DIR, `${id}.json`);
}

async function readWorkspace(id: string): Promise<Workspace | null> {
  return getStore().readJson<Workspace>(wsPath(id));
}

async function listWorkspaces(): Promise<Workspace[]> {
  await ensureWorkspacesDir();
  const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
  const results: Workspace[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const data = await getStore().readJson<Workspace>(path.join(WORKSPACES_DIR, e.name));
    if (data) results.push(data);
  }
  results.sort((a, b) => {
    const da = new Date(a.createdAt || 0).getTime();
    const db = new Date(b.createdAt || 0).getTime();
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

// ─── GET /api/v1/workspaces ───
// List all workspaces (JWT auth)

router.get('/', requireAuth(), requireAdmin(), defineRoute({}, async () => {
  return listWorkspaces();
}));

// ─── GET /api/v1/workspaces/runtimes ───
// （须注册在 /:id 之前——'runtimes' 单段会被 :id 吞掉，旧路由顺序如此）

router.get('/runtimes', requireAuth(), requireAdmin(), apiCache(60), defineRoute({}, async () => {
  // 本机 CLI 清单，供角色创建候选列表使用（原 AC-2.6「聚合所有 workspace」语义已废弃，见下）
  // 2026-07：聚合前先重扫本地 CLI（best-effort），保证本地 runtime 新鲜可见
  // #403（缓存 seam 决策树第 2 问）：响应为 HTTP GET、秒级陈旧可接受 → 挂 apiCache 60s。
  // 每请求 execFileSync 全量重扫所有 CLI（which + --version，timeout 5s/个）同步阻塞事件
  // 循环最坏数十秒，60s 档把重扫频次压到至多一次/分钟。
  const { rescanLocalRuntimes } = await import('./local-workspace.js');
  await rescanLocalRuntimes().catch(() => {});

  // 只取本机记录：多节点执行已无活路径（bdaf0dd3 2026-08-04 放弃远程节点方向），
  // 遍历全表会让历史/离线节点的 runtimes 永久出现在候选列表里。
  // nodeId / workspaceName 随之不再下发——创建角色只需要 provider。
  const ws = await resolveVpsWorkspace();
  const recorded = (ws?.runtimes ?? []) as Array<{
    provider?: string; version?: string; auth?: string; authHint?: string;
    models?: string[]; modelsSource?: 'live' | 'fallback';
  }>;
  const runtimes = recorded
    .filter((rt) => typeof rt.provider === 'string' && rt.provider.length > 0)
    // #565 AC4: auth 三态透出（旧记录无 auth 字段 → unknown），failed 附修复 hint
    .map((rt) => ({
      provider: rt.provider as string,
      version: rt.version ?? '',
      auth: rt.auth ?? 'unknown',
      ...(rt.authHint ? { authHint: rt.authHint } : {}),
      // #574: 模型清单 + 来源标注透出（旧记录无字段则不带）
      ...(Array.isArray(rt.models) && rt.models.length > 0
        ? { models: rt.models, modelsSource: rt.modelsSource ?? 'fallback' }
        : {}),
    }));

  return { runtimes };
}));

// ─── DELETE /api/v1/workspaces/:id ───

router.delete('/:id', requireAuth(), requireAdmin(), defineRoute({ params: workspaceIdParamsSchema }, async (_req, _res, { params }) => {
  const workspace = await readWorkspace(params.id);
  if (!workspace) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Workspace not found');
  }
  await deleteWorkspaceDir(params.id);
  logger.info({ workspaceId: params.id }, '[Workspace] Deleted');
  return { deleted: true };
}));

// ─── GET /api/v1/workspaces/:id/runtimes ───

router.get('/:id/runtimes', requireAuth(), requireAdmin(), defineRoute({ params: workspaceIdParamsSchema }, async (_req, _res, { params }) => {
  const workspace = await readWorkspace(params.id);
  if (!workspace) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Workspace not found');
  }
  const runtimes = ((workspace.runtimes ?? []) as WorkspaceRuntime[]).slice().sort((a, b) =>
    (a.provider as string).localeCompare(b.provider as string),
  );
  return runtimes;
}));

// ─── GET /api/v1/workspaces/:id ───

router.get('/:id', requireAuth(), requireAdmin(), defineRoute({ params: workspaceIdParamsSchema }, async (_req, _res, { params }) => {
  const workspace = await readWorkspace(params.id);
  if (!workspace) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Workspace not found');
  }
  return workspace;
}));

export default router;
