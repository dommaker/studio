/**
 * KnowledgeService HTTP API + SSE
 *
 * Exposes KnowledgeService capabilities over HTTP.
 * Mounted at /api/v1/knowledge-service
 *
 * 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
 * 手写 guard（q/entryId/必填字段/record-outcome 三件套等）收进 zod；404 走
 * HttpError；响应统一 `{ data }` 壳（原平铺 `{ results, total }` / `{ entries, total }`
 * / 裸 entry / `{ success }` / 裸 stats-health-flywheel-audit-accuracy 对象）；错误统一
 * `{ error: { code, message } }`（原 `{ error: string }`；500 文案由 String(e) 保留）。
 * GET /events 301 跳转提示 handler 自写 res 不进壳。
 * 遗留：GET /entries/stats 注册在 GET /entries/:id 之后被遮蔽（id='stats'），
 * 迁移保持原注册顺序，行为不变。
 */

import { Router } from 'express';
import {
  knowledgeServiceSearchQuerySchema,
  listKnowledgeEntriesQuerySchema,
  knowledgeEntryIdParamsSchema,
  createKnowledgeEntryBodySchema,
  updateKnowledgeEntryBodySchema,
  recordPatternBodySchema,
  recordIncidentBodySchema,
  recordTrendBodySchema,
  injectContextBodySchema,
  matchResolutionsBodySchema,
  recordOutcomeBodySchema,
  knowledgeLifecycleBodySchema,
  mergeKnowledgeBodySchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { knowledgeService } from './knowledge-service.js';
import { eventBus, logger } from '@dommaker/studio-shared';
import { requireNotGuest } from '../../middleware/auth.js';
import { parsePagination } from '../../utils/pagination.js';
import { defineRoute, HttpError } from '../../core/http.js';
import type { KnowledgeEntry } from '@dommaker/harness';

export const knowledgeServiceRoutes = Router();

// Request logging middleware
knowledgeServiceRoutes.use((req, _res, next) => {
  logger.info('[KnowledgeService API]', { method: req.method, path: req.path });
  next();
});

// ── Query ──

knowledgeServiceRoutes.get('/stats', defineRoute({}, async () => {
  return knowledgeService.getStats();
}));

knowledgeServiceRoutes.get('/search', defineRoute({ query: knowledgeServiceSearchQuerySchema }, async (req, _res, { query }) => {
  // #359：统一 parsePagination（clamp 1..100），缺省 10→20、上限 50→100
  const { limit } = parsePagination(req);
  const results = await knowledgeService.search(query.q, { limit });
  return { results, total: results.length };
}));

knowledgeServiceRoutes.get('/entries', defineRoute({ query: listKnowledgeEntriesQuerySchema }, async (req, _res, { query }) => {
  const filter: Record<string, unknown> = {};
  if (query.type) filter.types = query.type.split(',');
  if (query.tags) filter.tags = query.tags.split(',');
  // 审核闭环：监控页待审列表数据源（maturity=draft）
  if (query.maturity) filter.maturity = query.maturity.split(',');
  // #359：统一 parsePagination（clamp 1..100），缺省从不设限 → 20
  filter.limit = parsePagination(req).limit;
  if (query.offset) filter.offset = Number(query.offset);
  const entries = await knowledgeService.list(filter as any);
  return { entries, total: entries.length };
}));

knowledgeServiceRoutes.get('/entries/:id', defineRoute({ params: knowledgeEntryIdParamsSchema }, async (_req, _res, { params }) => {
  const entry = await knowledgeService.get(params.id);
  if (!entry) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Not found');
  return entry;
}));

knowledgeServiceRoutes.post('/entries', requireNotGuest(), defineRoute(
  { body: createKnowledgeEntryBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    // zod passthrough 保留条目全字段；z.infer 退化（strict:false）→ 路由边界显式收回
    const entry = body as unknown as KnowledgeEntry;
    await knowledgeService.create(entry);
    return { success: true, id: entry.id };
  },
));

knowledgeServiceRoutes.put('/entries/:id', requireNotGuest(), defineRoute(
  { params: knowledgeEntryIdParamsSchema, body: updateKnowledgeEntryBodySchema },
  async (_req, _res, { params, body }) => {
    const updated = await knowledgeService.update(params.id, body as Partial<KnowledgeEntry>);
    if (!updated) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Not found');
    return updated;
  },
));

knowledgeServiceRoutes.delete('/entries/:id', requireNotGuest(), defineRoute(
  { params: knowledgeEntryIdParamsSchema },
  async (_req, _res, { params }) => {
    const deleted = await knowledgeService.delete(params.id);
    if (!deleted) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Not found');
    return { success: true };
  },
));

knowledgeServiceRoutes.get('/entries/stats', defineRoute({}, async () => {
  const stats = knowledgeService.getStats();
  const health = await knowledgeService.getHealthReport();
  return { ...stats, healthScore: (health as any).healthScore };
}));

// ── Produce ──

knowledgeServiceRoutes.post('/pattern', requireNotGuest(), defineRoute(
  { body: recordPatternBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const { type, title, content, tags, origin } = body;
    // #371：origin 白名单内人工声明（human/agent 计入蒸馏 topic 信号）；缺省走
    // recordPattern 的 system fail-closed，API 不得自封 system/external
    const declared = origin === 'human' || origin === 'agent' ? origin : undefined;
    await knowledgeService.recordPattern({ type, title, content, tags: tags || [], origin: declared });
    return { success: true };
  },
));

knowledgeServiceRoutes.post('/incident', requireNotGuest(), defineRoute(
  { body: recordIncidentBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const { title, content, severity, tags } = body;
    await knowledgeService.recordIncident({ title, content, severity: severity as any, tags: tags || [] });
    return { success: true };
  },
));

knowledgeServiceRoutes.post('/trend', requireNotGuest(), defineRoute(
  { body: recordTrendBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const { title, content, metric, tags } = body;
    await knowledgeService.recordTrend({ title, content, metric, tags: tags || [] });
    return { success: true };
  },
));

// ── Measure ──

knowledgeServiceRoutes.get('/health', defineRoute({}, async () => {
  return knowledgeService.getHealthReport();
}));

knowledgeServiceRoutes.get('/flywheel', defineRoute({}, async () => {
  return knowledgeService.getFlywheelMetrics();
}));

knowledgeServiceRoutes.get('/audit', defineRoute({}, async () => {
  return knowledgeService.getAuditReport();
}));

knowledgeServiceRoutes.get('/analyst-accuracy', defineRoute({}, async () => {
  return knowledgeService.getAnalystAccuracy();
}));

// ── Consume ──

knowledgeServiceRoutes.post('/inject-context', defineRoute({ body: injectContextBodySchema }, async (_req, _res, { body }) => {
  const { agentType, tags, maxTokens, includeRules } = body;
  const result = await knowledgeService.injectContext(agentType, { tags, maxTokens, includeRules });
  return { context: result.prompt, injectedIds: result.injectedIds };
}));

knowledgeServiceRoutes.post('/match-resolutions', defineRoute({ body: matchResolutionsBodySchema }, async (_req, _res, { body }) => {
  const { resolutionService } = await import('./resolution.service.js');
  return resolutionService.matchResolutions({ errorMessage: body.problem });
}));

// ── Track ──

knowledgeServiceRoutes.post('/record-outcome', requireNotGuest(), defineRoute(
  { body: recordOutcomeBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const { executionId, agentType, consumedKnowledge, success, details, timestamp, mode } = body;
    await knowledgeService.recordOutcome({
      executionId, agentType, consumedKnowledge: consumedKnowledge || [],
      success, details: details || '', timestamp: timestamp || new Date().toISOString(), mode: mode as any,
    });
    return { success: true };
  },
));

// ── Lifecycle ──

knowledgeServiceRoutes.post('/promote', requireNotGuest(), defineRoute(
  { body: knowledgeLifecycleBodySchema },
  async (_req, _res, { body }) => {
    await knowledgeService.promote(body.entryId);
    return { success: true };
  },
));

// 审核闭环 reject 端点：draft → archived（与 /promote 对称）
knowledgeServiceRoutes.post('/demote', requireNotGuest(), defineRoute(
  { body: knowledgeLifecycleBodySchema },
  async (_req, _res, { body }) => {
    await knowledgeService.demote(body.entryId);
    return { success: true };
  },
));

knowledgeServiceRoutes.post('/decay', requireNotGuest(), defineRoute(
  { body: knowledgeLifecycleBodySchema },
  async (_req, _res, { body }) => {
    await knowledgeService.decay(body.entryId);
    return { success: true };
  },
));

knowledgeServiceRoutes.post('/merge', requireNotGuest(), defineRoute(
  { body: mergeKnowledgeBodySchema },
  async (_req, _res, { body }) => {
    await knowledgeService.merge(body.sourceId, body.targetId);
    return { success: true };
  },
));

// ── SSE: Bridge KnowledgeService events to general eventBus ──
// Knowledge events are now available at /api/v1/events/stream?topics=knowledge
// This endpoint redirects to the general SSE stream.

knowledgeServiceRoutes.get('/events', defineRoute({}, async (_req, res) => {
  res.status(301).json({
    message: 'Knowledge events are now available at /api/v1/events/stream?topics=knowledge',
    url: '/api/v1/events/stream?topics=knowledge',
  });
}));

// One-time bridge: subscribe KnowledgeService EventEmitter → eventBus（#324 直发对象，无字符串壳）
let bridgeInitialized = false;
export function initKnowledgeEventBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;

  const emitter = (knowledgeService as any).deps?.eventEmitter;
  if (!emitter) {
    logger.warn('[KnowledgeService] EventEmitter not available, bridge not started');
    return;
  }

  emitter.on('knowledge', (event: { type: string; data: unknown }) => {
    eventBus.publish('events', {
      event_type: `knowledge.${event.type}`,
      payload: event.data,
      timestamp: new Date().toISOString(),
    });
  });

  logger.info('[KnowledgeService] Event bridge initialized → eventBus');
}
