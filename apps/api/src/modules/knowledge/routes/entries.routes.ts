/**
 * entries.routes — 知识条目子路由（KnowledgeStore 条目的缺口查询/统一浏览）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET  /gaps/:type  G-001~005: 五大知识缺口查询
 * - GET  /unified     AS-022: 统一知识浏览
 * - POST /unified     AS-022: 手动知识条目创建
 *
 * P4.2（2026-10-17）：GET /export、POST /ask、GET /gaps（统计概览）为孤儿端点
 * （web/cli/mcp/studio-config 均无消费方）已删；连带 KnowledgeQueryService.getStats、
 * contract 配套 schema 与 response-map 映射一并摘除（见 CONTEXT.md）。
 *
 * 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
 * 必填四件套/gaps type 词表 guard 收进 zod（原手写 400）；响应统一
 * `{ data }` 壳（原平铺 `{ type, data, total }` / `{ entries, total }` /
 * 201 `{ id, title, consumptionMode }`）；错误统一
 * `{ error: { code, message } }`（500 文案由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import {
  knowledgeGapParamsSchema,
  knowledgeGapQuerySchema,
  unifiedKnowledgeQuerySchema,
  createUnifiedEntryBodySchema,
  knowledgeEntryParamsSchema,
  updateKnowledgeScopeBodySchema,
  knowledgeSuccessResponseSchema,
  knowledgeGapsResponseSchema,
  unifiedKnowledgeListResponseSchema,
  createUnifiedEntryResponseSchema,
} from '@dommaker/studio-contract';
import { sharedStore, publishKnowledgeEntryChanged } from '../knowledge-singletons.js';
import { requireNotGuest } from '../../../middleware/auth.js';
import { parsePagination } from '../../../utils/pagination.js';
import { defineRoute, HttpError } from '../../../core/http.js';
import { completeKnowledgeScope, manualLearningMetadata, withLearningMetadata } from '../learning-metadata.js';

export const entriesRoutes = Router();

// ============================================
// G-001~005: 五大知识缺口查询 API
// ============================================

/**
 * GET /api/v1/knowledge/gaps/:type
 * 查询五种知识类型: preference | business_rule | environment | decision_chain | interaction
 * （非法 type 原手写 400 → zod enum 400，文案变 zod 格式）
 */
entriesRoutes.get('/gaps/:type', defineRoute(
  { params: knowledgeGapParamsSchema, query: knowledgeGapQuerySchema, response: knowledgeGapsResponseSchema },
  async (req, _res, { params, query }) => {
    const { type } = params;

    const { knowledgeQuery } = await import('../knowledge-query.service.js');
    const data = await knowledgeQuery.query({
      type: type as any,
      topic: query.topic,
      category: query.category,
      // #359：统一 parsePagination（clamp 1..100），缺省 20 与既有口径一致
      limit: parsePagination(req).limit,
    });
    return { type, data, total: data.length };
  },
));

// ── AS-022: Unified Knowledge API ─────────────────────────

// Lazy-load UnifiedQuery to avoid circular deps
let _uq: InstanceType<typeof import('../engine/unified-query.js').UnifiedQuery> | null = null;
async function getUnifiedQuery() {
  if (!_uq) {
    const { UnifiedQuery } = await import('../engine/unified-query.js');
    _uq = new UnifiedQuery();
  }
  return _uq;
}

/**
 * GET /unified — unified knowledge browser
 * Query params: consumptionMode, tags, origin, maturity, limit（默认 20，上限 100 — #359 起统一 parsePagination，原缺省 50）, offset, sortBy
 */
entriesRoutes.get('/unified', defineRoute({ query: unifiedKnowledgeQuerySchema, response: unifiedKnowledgeListResponseSchema }, async (req, _res, { query }) => {
  const uq = await getUnifiedQuery();
  const filter = {
    consumptionModes: query.consumptionMode ? query.consumptionMode.split(',') : undefined,
    tags: query.tags ? query.tags.split(',') : undefined,
    origins: query.origin ? query.origin.split(',') : undefined,
    maturity: query.maturity ? query.maturity.split(',') : undefined,
    excludeTags: ['low_quality'],
    limit: parsePagination(req).limit,
    offset: query.offset ? Number(query.offset) : 0,
    sortBy: query.sortBy as any || 'lastReferenced',
    sources: ['store' as const],
  };
  return uq.listEntries(filter);
}));

/**
 * POST /unified — manual knowledge entry creation
 * Body: { type, title, content, consumptionMode, applicableAgents?, tags? }
 * （必填四件套原手写 400 → zod 400）
 */
entriesRoutes.post('/unified', requireNotGuest(), defineRoute(
  { body: createUnifiedEntryBodySchema, response: createUnifiedEntryResponseSchema },
  { status: 201 },
  async (req, _res, { body }) => {
    const { type, title, content, consumptionMode, applicableAgents, tags, scope } = body;

    const { sharedStore } = await import('../knowledge-singletons.js');
    const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    // #93：人工创建本身就是出处凭证——不 stamp 的话 hasSourceReferences 闸门会永远拦住该条目
    const operator = (req as any).user?.id ?? 'unknown';

    // Store applicableAgents in tags (KnowledgeEntry doesn't have applicableAgents field)
    const entryTags = [...(tags || []), ...(applicableAgents || []).map((a: string) => `agent:${a}`)];

    sharedStore.save({
      id,
      // zod 边界为自由 string（wire 词表比 harness KnowledgeSubsystem/ConsumptionMode 宽）→ 显式收回
      type: type as any,
      title,
      content,
      maturity: 'draft',
      layer: 'project',
      created: now,
      lastReferenced: now,
      contributors: ['manual'],
      projects: [],
      tags: entryTags,
      applicablePhases: [],
      sourceReferences: [withLearningMetadata(
        { source: `manual:${operator}`, timestamp: now },
        manualLearningMetadata(scope),
      )],
      referencedBy: [],
      executionResults: [],
      consumptionMode: consumptionMode as any,
      origin: 'human',
    });

    // Step 2：人工创建同样广播（他端开着的 KnowledgePage 实时刷新；本端提交后本就会 reload）
    publishKnowledgeEntryChanged('created', { entryId: id, entryType: type, title });

    return { id, title, consumptionMode };
  },
));

/** #715：人工补全 legacy 作用域；其他来源、版本和结果字段不得借此端点改写。 */
entriesRoutes.patch('/unified/:entryId', requireNotGuest(), defineRoute(
  { params: knowledgeEntryParamsSchema, body: updateKnowledgeScopeBodySchema, response: knowledgeSuccessResponseSchema },
  async (_req, _res, { params, body }) => {
    const result = completeKnowledgeScope(sharedStore, params.entryId, body.scope);
    if (result.status === 'not-found') throw new HttpError(404, 'NOT_FOUND', `Knowledge entry not found: ${params.entryId}`);
    if (result.status === 'already-scoped') throw new HttpError(409, 'CONFLICT', `Knowledge scope already set: ${params.entryId}`);
    publishKnowledgeEntryChanged('updated', {
      entryId: result.entry.id, entryType: result.entry.type, title: result.entry.title,
    });
    return { success: true };
  },
));
