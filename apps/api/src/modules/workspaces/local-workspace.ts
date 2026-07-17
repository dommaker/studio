/**
 * Local Workspace Registration — AS-020 P2-04
 *
 * Server startup auto-creates local Workspace record:
 *   - Token=NULL (VPS is the Server itself, no remote token auth)
 *   - name="VPS"
 *   - workspaceRoot from config
 *
 * Runs once on server start. Idempotent.
 */

import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'data', 'workspaces');
const RUNTIMES_DIR = path.join(os.homedir(), '.studio', 'data', 'workspace-runtimes');

const VPS_WORKSPACE_NAME = 'VPS';

/**
 * Ensure local VPS workspace exists in DB.
 * Called once on server startup.
 */
export async function ensureLocalWorkspace(): Promise<string> {
  // Check if local workspace already exists (token IS NULL) — FileStore
  let existing: { id: string } | null = null;
  try {
    await fs.promises.mkdir(WORKSPACES_DIR, { recursive: true });
    const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = await fileStore.readJson<any>(path.join(WORKSPACES_DIR, e.name));
      if (data && data.name === VPS_WORKSPACE_NAME && !data.tokenId) {
        existing = data;
        break;
      }
    }
  } catch { /* dir may not exist */ }

  if (existing) {
    logger.info({ workspaceId: existing.id }, '[LocalWorkspace] Found existing VPS workspace');
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
 * Scan for locally installed CLI runtimes and register them.
 */
async function scanLocalRuntimes(workspaceId: string): Promise<void> {
  const { execSync } = await import('child_process');

  const providers = [
    { provider: 'claude', cmd: 'which claude' },
    { provider: 'opencode', cmd: 'which opencode' },
    { provider: 'codex', cmd: 'which codex' },
  ];

  for (const { provider, cmd } of providers) {
    try {
      const binPath = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!binPath) continue;

      // Try to get version
      let version: string | null = null;
      try {
        version = execSync(`${provider} --version`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch {
        // Version detection is best-effort
      }

      const runtimeId = `${workspaceId}_${provider}`;
      const runtimeFile = path.join(RUNTIMES_DIR, `${runtimeId}.json`);
      await fs.promises.mkdir(RUNTIMES_DIR, { recursive: true });
      const existingRt = await fileStore.readJson<any>(runtimeFile);
      const now = new Date().toISOString();
      if (existingRt) {
        existingRt.version = version;
        existingRt.status = 'online';
        existingRt.lastSeenAt = now;
        existingRt.updatedAt = now;
        await fileStore.writeJson(runtimeFile, existingRt);
      } else {
        await fileStore.writeJson(runtimeFile, {
          id: runtimeId,
          workspaceId,
          provider,
          name: provider,
          version,
          status: 'online',
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }

      logger.info({ workspaceId, provider, version }, '[LocalWorkspace] Registered runtime');
    } catch {
      // CLI not installed — skip
    }
  }
}
