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
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

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

router.post('/', requireAuth(), async (req: Request, res: Response) => {
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

    // Hash token for storage (SHA-256, deterministic for DB lookup)
    const tokenHash = hashToken(plaintextToken);

    const workspaceToken = await prisma.workspaceToken.create({
      data: {
        name: name.trim(),
        tokenHash,
        permissions: JSON.stringify(permissions),
      },
    });

    logger.info({ tokenId: workspaceToken.id, name: workspaceToken.name }, '[WorkspaceToken] Created');

    return res.status(201).json({
      success: true,
      data: {
        id: workspaceToken.id,
        name: workspaceToken.name,
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

router.get('/', requireAuth(), async (_req: Request, res: Response) => {
  try {
    const tokens = await prisma.workspaceToken.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { workspaces: true } },
      },
    });

    const masked = tokens.map(t => ({
      id: t.id,
      name: t.name,
      permissions: JSON.parse(t.permissions),
      tokenHash: maskToken(t.tokenHash),
      createdAt: t.createdAt,
      revokedAt: t.revokedAt,
      workspaceCount: t._count.workspaces,
    }));

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

router.delete('/:id', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const token = await prisma.workspaceToken.findUnique({ where: { id } });
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

    const revoked = await prisma.workspaceToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    logger.info({ tokenId: id, name: revoked.name }, '[WorkspaceToken] Revoked');

    return res.json({
      success: true,
      data: {
        id: revoked.id,
        name: revoked.name,
        revokedAt: revoked.revokedAt,
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
