/**
 * G30: StudioEvent API Endpoints
 *
 * POST /api/v1/events — create a StudioEvent (JWT auth)
 * GET  /api/v1/events — query StudioEvents by type, since, limit (JWT auth)
 *
 * B9-014: Agent Event Protocol API
 * POST /api/v1/events/agent-events — batch ingest AgentEvent[] (JWT auth)
 */

import { Router, Request, Response } from 'express';
import { logger, FileStore } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import { generateSessionSummary } from './session-summary-generator.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { writeStudioEvent, isEmptyEventPayload } from '../../utils/studio-events.js';

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const fileStore = new FileStore();

const router = Router();

// ── B9-014: Agent Event Protocol types ──

interface AgentEvent {
  sessionId: string;
  agentId: string;
  timestamp: number;
  type: string;
  payload?: unknown;
}

/**
 * POST /api/v1/events
 * Create a new StudioEvent.
 * Body: { type: string, source: string, payload: Record<string, unknown> }
 * D18：payload 为空（{} / null / undefined）拒绝落盘 → 400（调用方自查）。
 */
router.post('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { type, source, payload } = req.body;
    if (!type || !source) {
      return res.status(400).json({ error: 'type and source are required' });
    }
    if (isEmptyEventPayload(payload)) {
      return res.status(400).json({ error: 'payload must be a non-empty object' });
    }

    const written = await writeStudioEvent(type, payload, { source });
    if (!written) {
      return res.status(500).json({ error: 'Failed to create event' });
    }

    res.status(201).json({
      type,
      source,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      createdAt: new Date().toISOString(),
    });
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
router.get('/', async (req: Request, res: Response) => {
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

    const allEvents = await fileStore.readJsonl<any>(STUDIO_EVENTS_JSONL);
    let filtered = allEvents;
    if (typeof type === 'string' && type) {
      filtered = filtered.filter((e: any) => e.type === type);
    }
    if (typeof since === 'string' && since) {
      const sinceDate = new Date(since);
      filtered = filtered.filter((e: any) => new Date(e.createdAt) >= sinceDate);
    }
    filtered.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const events = filtered.slice(0, limit);

    res.json({ events, total: events.length });
  } catch (error: any) {
    logger.error('[StudioEvent] GET failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to query events' });
  }
});

/**
 * POST /api/v1/events/agent-events
 * B9-014: Agent Event Protocol — batch ingest events from any agent.
 * Body: AgentEvent[] — array of events with { sessionId, agentId, timestamp, type, payload? }
 * Validates required fields, stores each as a StudioEvent.
 */
router.post('/agent-events', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const events: AgentEvent[] = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'Body must be a non-empty AgentEvent[]' });
    }

    if (events.length > 500) {
      return res.status(400).json({ error: 'Max 500 events per batch' });
    }

    // Validate each event
    const errors: string[] = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e.sessionId) errors.push(`[${i}].sessionId required`);
      if (!e.agentId) errors.push(`[${i}].agentId required`);
      if (!e.timestamp || typeof e.timestamp !== 'number') errors.push(`[${i}].timestamp (number) required`);
      if (!e.type) errors.push(`[${i}].type required`);
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // Batch insert — map AgentEvent → StudioEvent（D18：统一写入入口；payload 恒含 sessionId 非空）
    for (const e of events) {
      const written = await writeStudioEvent(e.type, {
        sessionId: e.sessionId,
        ...(typeof e.payload === 'object' && e.payload !== null ? e.payload : {}),
      }, {
        source: e.agentId,
        createdAt: new Date(e.timestamp).toISOString(),
      });
      if (!written) throw new Error(`event write rejected/failed: ${e.type}`);
    }

    logger.info('[AgentEvents] Batch ingested', { count: events.length, agentId: events[0].agentId });
    res.status(201).json({ ingested: events.length });

    // B9-015: fire-and-forget session:summary generation on session:end
    const sessionEndEvents = events.filter((e) => e.type === 'session:end');
    for (const se of sessionEndEvents) {
      generateSessionSummary(se.sessionId).catch((err: unknown) => {
        logger.warn('[AgentEvents] SessionSummary generation failed', { sessionId: se.sessionId, error: String(err) });
      });
    }
  } catch (error: unknown) {
    logger.error('[AgentEvents] Batch ingest failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to ingest agent events' });
  }
});

export default router;
