/**
 * Local Workspace Registration — AS-020 P2-04
 *
 * Server startup auto-creates local Workspace record:
 *   - Token=NULL (VPS is the Server itself, no remote token auth)
 *   - name="VPS"
 *   - workspaceRoot from config
 *
 * Runs once on server start. Idempotent.
 *
 * 2026-07 修复：本地 CLI 扫描改走 provider 注册表（daemon/cli-scanner），
 * 结果写入 workspace 记录的 runtimes 数组（与 daemon 注册同构），
 * 每次启动 + GET /workspaces/runtimes 时重扫，保证前端可见、新鲜。
 */

import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');

const VPS_WORKSPACE_NAME = 'VPS';

/** 查找本地（token=NULL）VPS workspace 记录 */
async function findLocalWorkspace(): Promise<Record<string, any> | null> {
  try {
    await fs.promises.mkdir(WORKSPACES_DIR, { recursive: true });
    const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = await fileStore.readJson<any>(path.join(WORKSPACES_DIR, e.name));
      if (data && data.name === VPS_WORKSPACE_NAME && !data.tokenId) {
        return data;
      }
    }
  } catch { /* dir may not exist */ }
  return null;
}

/**
 * Ensure local VPS workspace exists in DB.
 * Called once on server startup.
 */
export async function ensureLocalWorkspace(): Promise<string> {
  const existing = await findLocalWorkspace();
  if (existing) {
    logger.info({ workspaceId: existing.id }, '[LocalWorkspace] Found existing VPS workspace');
    // 每次启动重扫本地 CLI（best-effort），保持 runtimes 新鲜
    await scanLocalRuntimes(existing.id);
    return existing.id;
  }

  // Determine workspaceRoot from environment
  const workspaceRoot = process.env.VPS_WORKSPACE_ROOT
    || process.env.REPO_DIR
    || process.cwd();

  // Create local workspace (no token) — FileStore
  const id = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const now = new Date().toISOString();
  const workspace = {
    id,
    name: VPS_WORKSPACE_NAME,
    workspaceRoot,
    status: 'idle',
    hasDocker: false,
    os: process.platform,
    arch: process.arch,
    createdAt: now,
    updatedAt: now,
  };
  await fileStore.writeJson(path.join(WORKSPACES_DIR, `${id}.json`), workspace);

  logger.info({ workspaceId: id, workspaceRoot }, '[LocalWorkspace] Created VPS workspace');

  // Scan local CLI runtimes (best-effort)
  await scanLocalRuntimes(id);

  return id;
}

/**
 * 对本地 workspace 做一次重扫（供 GET /workspaces/runtimes 等按需调用）。
 * 本地 workspace 不存在时静默跳过。
 */
export async function rescanLocalRuntimes(): Promise<void> {
  const ws = await findLocalWorkspace();
  if (!ws) return;
  await scanLocalRuntimes(ws.id);
}

/**
 * Scan for locally installed CLI runtimes and register them.
 *
 * 走 provider 注册表（daemon/cli-scanner scanAllProviders）：内置
 * claude/kimi/codex/opencode，用户可经 ~/.studio/providers.json 扩展。
 * 结果全量替换 local workspace 记录的 runtimes 数组（该记录只承载本地扫描，
 * daemon 上报的远程 runtime 在各自 workspace 记录里，互不干扰）。
 */
async function scanLocalRuntimes(workspaceId: string): Promise<void> {
  try {
    const { scanAllProviders } = await import('../../daemon/cli-scanner.js');
    const detected = scanAllProviders();

    const wsFile = path.join(WORKSPACES_DIR, `${workspaceId}.json`);
    const workspace = await fileStore.readJson<any>(wsFile);
    if (!workspace) return;

    const now = new Date().toISOString();
    const prevByProvider = new Map<string, any>(
      (Array.isArray(workspace.runtimes) ? workspace.runtimes : []).map((r: any) => [r.provider, r]),
    );
    workspace.runtimes = detected.map(rt => {
      const prev = prevByProvider.get(rt.provider);
      return {
        id: prev?.id ?? `${workspaceId}_${rt.provider}`,
        provider: rt.provider,
        name: rt.provider,
        version: rt.version,
        path: rt.path,
        status: 'online',
        lastSeenAt: now,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
    });
    workspace.updatedAt = now;
    await fileStore.writeJson(wsFile, workspace);

    logger.info(
      { workspaceId, providers: detected.map(d => ({ provider: d.provider, version: d.version })) },
      '[LocalWorkspace] Runtimes refreshed',
    );
  } catch (err) {
    // 扫描失败不阻断启动/请求，仅记录
    logger.warn({ workspaceId, err }, '[LocalWorkspace] Runtime scan failed');
  }
}
