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

import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

const VPS_WORKSPACE_NAME = 'VPS';

/**
 * Ensure local VPS workspace exists in DB.
 * Called once on server startup.
 */
export async function ensureLocalWorkspace(): Promise<string> {
  // Check if local workspace already exists (token IS NULL)
  const existing = await prisma.workspace.findFirst({
    where: {
      name: VPS_WORKSPACE_NAME,
      tokenId: null,
    },
  });

  if (existing) {
    logger.info({ workspaceId: existing.id }, '[LocalWorkspace] Found existing VPS workspace');
    return existing.id;
  }

  // Determine workspaceRoot from environment
  const workspaceRoot = process.env.VPS_WORKSPACE_ROOT
    || process.env.REPO_DIR
    || process.cwd();

  // Create local workspace (no token)
  const workspace = await prisma.workspace.create({
    data: {
      name: VPS_WORKSPACE_NAME,
      workspaceRoot,
      status: 'idle',
      hasDocker: false,
      os: process.platform,
      arch: process.arch,
    },
  });

  logger.info({ workspaceId: workspace.id, workspaceRoot }, '[LocalWorkspace] Created VPS workspace');

  // Scan local CLI runtimes (best-effort)
  await scanLocalRuntimes(workspace.id);

  return workspace.id;
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

      await prisma.workspaceRuntime.upsert({
        where: {
          workspaceId_provider: {
            workspaceId,
            provider,
          },
        },
        update: {
          version,
          status: 'online',
          lastSeenAt: new Date(),
        },
        create: {
          workspaceId,
          provider,
          name: provider,
          version,
          status: 'online',
          lastSeenAt: new Date(),
        },
      });

      logger.info({ workspaceId, provider, version }, '[LocalWorkspace] Registered runtime');
    } catch {
      // CLI not installed — skip
    }
  }
}
