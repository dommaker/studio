/**
 * Discover Proxy — AS-020 P4: Proxy directory discovery through WS
 *
 * GET /api/v1/workspaces/:id/discover?path=xxx
 * → Find active WS connection for workspaceId
 * → Send { type: 'discover_request', path } over WS
 * → Wait for { type: 'discover_response', entries } (timeout 10s)
 * → Return entries to caller
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { logger } from '../../utils/logger.js';
import { discoverViaWs, isWorkspaceConnected } from './ws-gateway.js';

const router = Router();

// ─── GET /api/v1/workspaces/:id/discover ───
// Proxy directory discovery through active WS connection

router.get('/:id/discover', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { path, timeout: timeoutStr } = req.query;

    if (!path || typeof path !== 'string') {
      return res.status(400).json({
        error: 'path query parameter is required',
        code: 'MISSING_PATH',
      });
    }

    if (!isWorkspaceConnected(id)) {
      return res.status(503).json({
        error: 'Workspace is not connected via WebSocket',
        code: 'WORKSPACE_NOT_CONNECTED',
      });
    }

    const timeoutMs = timeoutStr ? parseInt(timeoutStr as string, 10) : 10_000;

    const entries = await discoverViaWs(id, path, timeoutMs);

    return res.json({
      success: true,
      data: entries,
      total: entries.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('timed out')) {
      return res.status(504).json({
        error: 'Discover request timed out',
        code: 'DISCOVER_TIMEOUT',
      });
    }

    if (message.includes('No active connection')) {
      return res.status(503).json({
        error: 'Workspace is not connected',
        code: 'WORKSPACE_NOT_CONNECTED',
      });
    }

    logger.error({ err }, '[DiscoverProxy] Error');
    return res.status(500).json({
      error: 'Discover proxy failed',
      code: 'DISCOVER_PROXY_ERROR',
    });
  }
});

export default router;
