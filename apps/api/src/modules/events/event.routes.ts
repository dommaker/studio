/**
 * G30: StudioEvent API Endpoints
 *
 * POST /api/v1/events — create a StudioEvent (JWT auth)
 * GET  /api/v1/events — query StudioEvents by type, since, limit (JWT auth)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { requireAuth } from '../../middleware/auth.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

/**
 * POST /api/v1/events
 * Create a new StudioEvent.
 * Body: { type: string, source: string, payload: Record<string, unknown> }
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { type, source, payload } = req.body;
    if (!type || !source) {
      return res.status(400).json({ error: 'type and source are required' });
    }

    const event = await prisma.studioEvent.create({
      data: {
        type,
        source,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
      },
    });

    res.status(201).json(event);
  } catch (error: any) {
    logger.error('[StudioEvent] POST failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to create event' });
  }
});

/**
 * GET /api/v1/events
 * Query StudioEvents with optional filters.
 * Query params:
 *   type   — filter by event type (string, optional)
 *   since  — ISO date string, only events after this timestamp (optional)
 *   limit  — max results (number, default 50, max 200)
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { type, since, limit: limitStr } = req.query;
    const limit = Math.min(Math.max(parseInt(String(limitStr || '50'), 10) || 50, 1), 200);

    const where: Record<string, unknown> = {};
    if (typeof type === 'string' && type) {
      where.type = type;
    }
    if (typeof since === 'string' && since) {
      where.timestamp = { gte: new Date(since) };
    }

    const events = await prisma.studioEvent.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    res.json({ events, total: events.length });
  } catch (error: any) {
    logger.error('[StudioEvent] GET failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to query events' });
  }
});

export default router;
