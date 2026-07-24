/**
 * Workspace Token Routes — AS-020 P2-05: Token management (admin)
 *
 * Endpoints (JWT auth required):
 *   POST   /api/v1/workspace-tokens      — Generate token (returns plaintext once)
 *   GET    /api/v1/workspace-tokens      — List tokens (masked)
 *   DELETE /api/v1/workspace-tokens/:id  — Revoke token
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const fileStore = new FileStore();
const TOKENS_DIR = path.join(os.homedir(), '.studio', 'workspace-tokens');
const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');
const router = Router();

async function ensureDir(): Promise<void> {
  await fs.promises.mkdir(TOKENS_DIR, { recursive: true });
}

async function listTokens(): Promise<any[]> {
  try {
    const entries = await fs.promises.readdir(TOKENS_DIR, { withFileTypes: true });
    const results: any[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = await fileStore.readJson<any>(path.join(TOKENS_DIR, e.name));
      if (data) results.push(data);
    }
    return results;
  } catch { return []; }
}

async function countWorkspacesForToken(tokenId: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(WORKSPACES_DIR, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const ws = await fileStore.readJson<any>(path.join(WORKSPACES_DIR, e.name));
      if (ws && ws.tokenId === tokenId) count++;
    }
    return count;
  } catch { return 0; }
}

// ─── Helper: generate st_mach_ token ───

function generateToken(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `st_mach_${random}`;
}

// ─── Helper: SHA-256 hash for deterministic DB lookup ───

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Helper: mask token for display ───

function maskToken(hash: string): string {
  // Show first 10 chars of hash + ellipsis
  return hash.slice(0, 10) + '...';
}

// ─── POST /api/v1/workspace-tokens ───
// Generate a new workspace token (returns plaintext once)

router.post('/', requireAuth(), requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { name, permissions = ['execute'] } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        error: 'name is required',
        code: 'MISSING_TOKEN_NAME',
      });
    }

    if (!Array.isArray(permissions)) {
      return res.status(400).json({
        error: 'permissions must be an array',
        code: 'INVALID_PERMISSIONS',
      });
    }

    // Generate plaintext token
    const plaintextToken = generateToken();

    // Hash token for storage (SHA-256, deterministic for lookup)
    const tokenHash = hashToken(plaintextToken);

    // Create both by-id and by-hash files for dual-lookup compatibility
    const tokenId = `wt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();
    const tokenData = {
      id: tokenId,
      name: name.trim(),
      tokenHash,
      permissions: JSON.stringify(permissions),
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await ensureDir();
    await fileStore.writeJson(path.join(TOKENS_DIR, `${tokenId}.json`), tokenData);
    // Also index by hash for auth lookups
    await fileStore.writeJson(path.join(TOKENS_DIR, `${tokenHash}.json`), tokenData);

    logger.info({ tokenId, name: tokenData.name }, '[WorkspaceToken] Created');

    return res.status(201).json({
      success: true,
      data: {
        id: tokenData.id,
        name: tokenData.name,
        permissions,
        token: plaintextToken, // Only returned once
      },
    });
  } catch (error) {
    logger.error({ error }, '[WorkspaceToken] Create failed');
    return res.status(500).json({
      error: 'Failed to create workspace token',
      code: 'WORKSPACE_TOKEN_CREATE_ERROR',
    });
  }
});

// ─── GET /api/v1/workspace-tokens ───
// List all tokens (masked)

router.get('/', requireAuth(), requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const allTokens = await listTokens();
    // Dedup by ID (both id.json and hash.json files exist)
    const seen = new Set<string>();
    const tokens = allTokens.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    tokens.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const masked = await Promise.all(tokens.map(async t => ({
      id: t.id,
      name: t.name,
      permissions: JSON.parse(t.permissions || '[]'),
      tokenHash: maskToken(t.tokenHash),
      createdAt: t.createdAt,
      revokedAt: t.revokedAt,
      workspaceCount: await countWorkspacesForToken(t.id),
    })));

    return res.json({
      success: true,
      data: masked,
      total: masked.length,
    });
  } catch (error) {
    logger.error({ error }, '[WorkspaceToken] List failed');
    return res.status(500).json({
      error: 'Failed to list workspace tokens',
      code: 'WORKSPACE_TOKEN_LIST_ERROR',
    });
  }
});

// ─── DELETE /api/v1/workspace-tokens/:id ───
// Revoke token (set revokedAt)

router.delete('/:id', requireAuth(), requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const token = await fileStore.readJson<any>(path.join(TOKENS_DIR, `${id}.json`));
    if (!token) {
      return res.status(404).json({
        error: 'Workspace token not found',
        code: 'WORKSPACE_TOKEN_NOT_FOUND',
      });
    }

    if (token.revokedAt) {
      return res.status(400).json({
        error: 'Token already revoked',
        code: 'WORKSPACE_TOKEN_ALREADY_REVOKED',
      });
    }

    const now = new Date().toISOString();
    token.revokedAt = now;
    token.updatedAt = now;
    await fileStore.writeJson(path.join(TOKENS_DIR, `${id}.json`), token);
    // Also update hash-indexed copy
    if (token.tokenHash) {
      await fileStore.writeJson(path.join(TOKENS_DIR, `${token.tokenHash}.json`), token);
    }

    logger.info({ tokenId: id, name: token.name }, '[WorkspaceToken] Revoked');

    return res.json({
      success: true,
      data: {
        id: token.id,
        name: token.name,
        revokedAt: token.revokedAt,
      },
    });
  } catch (error) {
    logger.error({ error }, '[WorkspaceToken] Revoke failed');
    return res.status(500).json({
      error: 'Failed to revoke workspace token',
      code: 'WORKSPACE_TOKEN_REVOKE_ERROR',
    });
  }
});

export default router;
