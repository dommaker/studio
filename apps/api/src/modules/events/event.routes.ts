/**
 * G30: StudioEvent API Endpoints
 *
 * POST /api/v1/events — create a StudioEvent (JWT auth)
 * GET  /api/v1/events — query StudioEvents（JWT auth；#180：type/since/until/level/keyword/
 *                       workUnitId 过滤 + 尾部倒读游标分页，替代全文件线性扫 + 200 硬顶）
 *
 * B9-014: Agent Event Protocol API
 * POST /api/v1/events/agent-events — batch ingest AgentEvent[] (JWT auth)
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { generateSessionSummary } from './session-summary-generator.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import {
  writeStudioEvent,
  isEmptyEventPayload,
  parseStudioEventPayload,
  resolveStudioEventsFile,
  getStudioEventTime,
  type StudioEventLevel,
} from '../../utils/studio-events.js';
import { readStudioEventsTail, studioEventLevelOf, levelAtLeast } from '../../utils/studio-events-tail.js';

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
 * Query StudioEvents with optional filters（#60 决策 Q3a，#180 实现）。
 * Query params:
 *   type       — filter by event type (string, optional)
 *   since      — ISO date string, only events at/after this timestamp (optional)
 *   until      — ISO date string, only events at/before this timestamp (optional)
 *   level      — 最低级别 debug|info|warning|critical（缺省 info：读取侧默认 ≥info，
 *                不硬编码 type 黑名单；level=debug 看全部含噪声）
 *   keyword    — 关键词（type/source/payload 大小写不敏感子串，optional）
 *   workUnitId — filter by payload.workUnitId（WU 过程回放：type=workunit:execution_step 时配套使用）
 *   limit      — 每页条数 (number, default 50, max 200)
 *   cursor     — 上一页返回的 nextCursor（尾部倒读游标；无效值忽略，从最新开始）
 * Response: { events（新→旧）, total（本页条数）, nextCursor（null = 没有更旧的） }
 */
const EVENT_LEVELS: StudioEventLevel[] = ['debug', 'info', 'warning', 'critical'];

router.get('/', requireAuth(), async (req: Request, res: Response) => {
  try {
    const { type, since, until, level: levelStr, keyword, workUnitId, limit: limitStr, cursor } = req.query;
    const limit = Math.min(Math.max(parseInt(String(limitStr || '50'), 10) || 50, 1), 200);
    const minLevel: StudioEventLevel = EVENT_LEVELS.includes(levelStr as StudioEventLevel)
      ? (levelStr as StudioEventLevel)
      : 'info';
    const sinceMs = typeof since === 'string' && since ? new Date(since).getTime() : null;
    const untilMs = typeof until === 'string' && until ? new Date(until).getTime() : null;
    const kw = typeof keyword === 'string' && keyword.trim() ? keyword.trim().toLowerCase() : null;

    // 组合过滤下推到倒读循环：limit 按匹配数计，扫满即停（不全文件线性扫）
    const match = (e: Record<string, unknown>): boolean => {
      if (typeof type === 'string' && type && e.type !== type) return false;
      if (!levelAtLeast(studioEventLevelOf(e), minLevel)) return false;
      if (sinceMs !== null || untilMs !== null) {
        const t = getStudioEventTime(e);
        if (!Number.isFinite(t)) return false;
        if (sinceMs !== null && t < sinceMs) return false;
        if (untilMs !== null && t > untilMs) return false;
      }
      if (typeof workUnitId === 'string' && workUnitId) {
        if (parseStudioEventPayload<{ workUnitId?: string }>(e)?.workUnitId !== workUnitId) return false;
      }
      if (kw) {
        const payloadText = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? '');
        const hay = `${String(e.type ?? '')} ${String(e.source ?? '')} ${payloadText}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    };

    const { events, nextCursor } = await readStudioEventsTail({
      file: resolveStudioEventsFile(), // 每请求解析：STUDIO_EVENTS_FILE 覆盖（测试/应急）即时生效
      limit,
      cursor: typeof cursor === 'string' && cursor ? cursor : undefined,
      match,
    });
    // 页内按事件时间倒序兜底（文件追加序基本即时间序，防同文件乱序行）
    events.sort((a, b) => getStudioEventTime(b) - getStudioEventTime(a));

    res.json({ events, total: events.length, nextCursor });
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
