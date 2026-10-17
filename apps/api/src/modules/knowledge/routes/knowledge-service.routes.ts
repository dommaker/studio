/**
 * KnowledgeService HTTP API（审核闭环面）
 *
 * Mounted at /api/v1/knowledge-service
 *
 * P4.1 孤儿端点删除（2026-10-17）：勘察确认无消费方的 20 条端点已删（stats/search/
 * entries CRUD 与 entries/stats/trend/decay/merge/events/analyst-accuracy/pattern/incident/
 * health/flywheel/audit/inject-context/match-resolutions/record-outcome）——对应
 * service 能力仍被 session-summary/knowledge-sync/monitor-alerts/ops 探针/
 * prompt-composer 等直调，仅收 HTTP 暴露面。保留 3 条有前端消费方的端点：
 * GET /entries（监控页待审列表，maturity=draft）、POST /promote、POST /demote
 * （apps/web/src/api/knowledge.ts）。
 *
 * 契约驱动迁移（2026-10 批次 4/7）余绪：保留端点走 core/http.ts defineRoute，
 * 响应统一 `{ data }` 壳，错误统一 `{ error: { code, message } }`。
 */

import { Router } from 'express';
import {
  listKnowledgeEntriesQuerySchema,
  knowledgeLifecycleBodySchema,
} from '@dommaker/studio-contract';
import { knowledgeService } from '../knowledge-service.js';
import { eventBus } from '@dommaker/studio-shared';
import { requireNotGuest } from '../../../middleware/auth.js';
import { parsePagination } from '../../../utils/pagination.js';
import { defineRoute } from '../../../core/http.js';
import { logger } from '@dommaker/studio-shared/node';

export const knowledgeServiceRoutes = Router();

// Request logging middleware
knowledgeServiceRoutes.use((req, _res, next) => {
  logger.info('[KnowledgeService API]', { method: req.method, path: req.path });
  next();
});

// 审核闭环：监控页待审列表数据源（maturity=draft，消费方 apps/web/src/api/knowledge.ts）
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

// 条目生命周期端点：MonitoringPage 人工 promote/demote（消费方 apps/web/src/api/knowledge.ts）
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
