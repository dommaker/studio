/**
 * G30: StudioEvent API Endpoints
 *
 * POST /api/v1/events — create a StudioEvent (JWT auth)
 * GET  /api/v1/events — query StudioEvents（JWT auth；#180：type/since/until/level/keyword/
 *                       workUnitId 过滤 + 尾部倒读游标分页，替代全文件线性扫 + 200 硬顶）
 *
 * B9-014 POST /api/v1/events/agent-events 已随 P4.6（2026-10-17）删除：仓内无代码消费方
 *（外部 runtime 来源已断）；session:end → session:summary 现由 generator 直接监听
 * StudioEvent 文件并执行启动恢复，不依赖 HTTP 入口。
 *
 * 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——type/source 必填
 * 收进 zod；D18 空 payload 拒绝（isEmptyEventPayload 唯一口径，含字符串 '{}' 语义）
 * 与写盘被拒保留 HttpError 显式文案；响应统一 `{ data }` 壳（原裸对象/平铺进壳）；
 * 错误统一 `{ error: { code, message } }`（原 `{ error: string }` 退役；500 文案由固定串
 * 变为实际错误消息）。
 * 鉴权（P2-e 声明式统一）：open（GET /，registry 挂 auth）/ write（POST /，registry 挂
 * authNotGuest）拆 router；注册顺序（sseRoutes 先于本 router 挂在 /api/v1/events）
 * 保持原样；SSE /events/stream 不在本文件、不迁。
 */

import { Router } from 'express';

import {
  writeStudioEvent,
  isEmptyEventPayload,
  parseStudioEventPayload,
  resolveStudioEventsFile,
  getStudioEventTime,
  type StudioEventLevel,
} from '@dommaker/studio-shared';
import { readStudioEventsTail, studioEventLevelOf, levelAtLeast } from '../../utils/studio-events-tail.js';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  ERROR_CODES,
  createStudioEventBodySchema,
  listStudioEventsQuerySchema,
  createStudioEventResponseSchema,
  eventSearchResponseSchema,
} from '@dommaker/studio-contract';

// P2-e 鉴权声明式统一：open（GET /，registry 挂 auth）/ write（POST /，registry 挂
// authNotGuest）拆 router，路由内不再挂鉴权。
const openRoutes = Router();
const writeRoutes = Router();

/**
 * POST /api/v1/events
 * Create a new StudioEvent.
 * Body: { type: string, source: string, payload: Record<string, unknown> }
 * D18：payload 为空（{} / null / undefined）拒绝落盘 → 400（调用方自查）。
 */
writeRoutes.post('/', defineRoute(
  { body: createStudioEventBodySchema, response: createStudioEventResponseSchema },
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

openRoutes.get('/', defineRoute(
  { query: listStudioEventsQuerySchema, response: eventSearchResponseSchema },
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

    const wireEvents = events.map(event => ({
      ...event,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      source: typeof event.source === 'string' ? event.source : undefined,
      level: studioEventLevelOf(event),
      payload: typeof event.payload === 'string' ? event.payload : undefined,
      createdAt: typeof event.createdAt === 'string' ? event.createdAt : undefined,
    }));
    return { events: wireEvents, total: wireEvents.length, nextCursor };
  },
));

export { openRoutes as eventOpenRoutes, writeRoutes as eventWriteRoutes };
