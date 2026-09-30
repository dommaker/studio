/**
 * G30: StudioEvent API Endpoints
 *
 * POST /api/v1/events — create a StudioEvent (JWT auth)
 * GET  /api/v1/events — query StudioEvents（JWT auth；#180：type/since/until/level/keyword/
 *                       workUnitId 过滤 + 尾部倒读游标分页，替代全文件线性扫 + 200 硬顶）
 *
 * B9-014: Agent Event Protocol API
 * POST /api/v1/events/agent-events — batch ingest AgentEvent[] (JWT auth)
 *
 * 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——type/source 必填
 * 与 agent-events 数组/逐条字段校验收进 zod；D18 空 payload 拒绝（isEmptyEventPayload
 * 唯一口径，含字符串 '{}' 语义）与写盘被拒保留 HttpError 显式文案；响应统一 `{ data }`
 * 壳（原裸对象/平铺进壳）；错误统一 `{ error: { code, message } }`（原 `{ error: string }`
 * 与 agent-events 的 `{ error, details }` 退役；500 文案由固定串变为实际错误消息）。
 * 鉴权挂载（requireAuth/requireNotGuest）与 route-registry 注册顺序（sseRoutes 先于
 * 本 router 挂在 /api/v1/events）保持原样；SSE /events/stream 不在本文件、不迁。
 */

import { Router } from 'express';
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
import { defineRoute, HttpError } from '../../core/http.js';
import {
  ERROR_CODES,
  createStudioEventBodySchema,
  listStudioEventsQuerySchema,
  agentEventBatchBodySchema,
} from '@dommaker/studio-contract';

const router = Router();

/**
 * POST /api/v1/events
 * Create a new StudioEvent.
 * Body: { type: string, source: string, payload: Record<string, unknown> }
 * D18：payload 为空（{} / null / undefined）拒绝落盘 → 400（调用方自查）。
 */
router.post('/', requireAuth(), requireNotGuest(), defineRoute(
  { body: createStudioEventBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const { type, source, payload } = body;
    if (isEmptyEventPayload(payload)) {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'payload must be a non-empty object');
    }

    const written = await writeStudioEvent(type, payload, { source });
    if (!written) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, 'Failed to create event');
    }

    return {
      type,
      source,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      createdAt: new Date().toISOString(),
    };
  },
));

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
 * Response: { data: { events（新→旧）, total（本页条数）, nextCursor（null = 没有更旧的） } }
 */
const EVENT_LEVELS: StudioEventLevel[] = ['debug', 'info', 'warning', 'critical'];

router.get('/', requireAuth(), defineRoute(
  { query: listStudioEventsQuerySchema },
  async (_req, _res, { query }) => {
    const { type, since, until, level: levelStr, keyword, workUnitId, limit: limitStr, cursor } = query;
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

    return { events, total: events.length, nextCursor };
  },
));

/**
 * POST /api/v1/events/agent-events
 * B9-014: Agent Event Protocol — batch ingest events from any agent.
 * Body: AgentEvent[] — array of events with { sessionId, agentId, timestamp, type, payload? }
 * （zod 校验非空数组 / ≤500 上限 / 逐条必填字段；原「Validation failed + details[]」
 * 聚合错误体随之退役为 zod 首错格式）
 */
router.post('/agent-events', requireAuth(), requireNotGuest(), defineRoute(
  { body: agentEventBatchBodySchema },
  { status: 201 },
  async (_req, _res, { body: events }) => {
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

    // B9-015: fire-and-forget session:summary generation on session:end
    const sessionEndEvents = events.filter((e) => e.type === 'session:end');
    for (const se of sessionEndEvents) {
      generateSessionSummary(se.sessionId).catch((err: unknown) => {
        logger.warn('[AgentEvents] SessionSummary generation failed', { sessionId: se.sessionId, error: String(err) });
      });
    }

    return { ingested: events.length };
  },
));

export default router;
