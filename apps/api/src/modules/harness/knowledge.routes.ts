/**
 * knowledge.routes — Harness 知识引擎子路由（T-010）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST   /knowledge/query  带 token 预算的知识查询
 * - GET    /knowledge        知识条目列表（30s TTL 缓存）
 * - GET    /knowledge/:id    知识条目详情
 * - POST   /knowledge        保存知识条目
 * - DELETE /knowledge/:id    删除知识条目
 * - POST   /knowledge/lint   运行知识 lint
 *
 * FileKnowledgeStore / KnowledgeQuery 单例与 TTL 缓存见 runtime.ts。
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * budget（positive，对齐原 !budget 拒 0）与 id/title/content 必填收进 zod
 * （原手写 400 退役）；列表壳内层 data 键改名词键进 `{ data }` 壳
 * （list→entries、lint→issues，无消费方）；平铺 `{ saved, id }` / `{ deleted }`
 * 进壳；错误统一 `{ error: { code, message } }`（503 SERVICE_UNAVAILABLE；
 * 500 message 由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import type { QueryBudget } from '@dommaker/harness';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  knowledgeQueryBodySchema,
  harnessKnowledgeListQuerySchema,
  harnessKnowledgeSaveBodySchema,
  harnessIdParamsSchema,
} from '@dommaker/studio-contract';
import {
  loadHarness,
  harnessModule,
  getCached,
  setCache,
  getKnowledgeStore,
  getKnowledgeQuery,
} from './runtime.js';

export const knowledgeRoutes = Router();

const HARNESS_UNAVAILABLE = () => new HttpError(503, 'SERVICE_UNAVAILABLE', 'Harness not available');

// ─── Knowledge Engine (T-010) ───

/**
 * POST /api/v1/harness/knowledge/query
 * Query knowledge with token budget
 */
knowledgeRoutes.post('/knowledge/query', defineRoute(
  { body: knowledgeQueryBodySchema },
  async (_req, _res, { body }) => {
    const query = await getKnowledgeQuery();
    if (!query) throw HARNESS_UNAVAILABLE();

    // budget wire 为 number，QueryBudget 类型边界收回
    return query.query(body.budget as unknown as QueryBudget, body.filter) as unknown as Record<string, unknown>;
  },
));

/**
 * GET /api/v1/harness/knowledge
 * List knowledge entries
 */
knowledgeRoutes.get('/knowledge', defineRoute(
  { query: harnessKnowledgeListQuerySchema },
  async (_req, _res, { query }) => {
    const cacheKey = 'knowledge_list';
    const cached = getCached<{ entries: unknown[]; total: number }>(cacheKey);
    if (cached) return cached;

    const store = await getKnowledgeStore();
    if (!store) throw HARNESS_UNAVAILABLE();

    const filter: Record<string, unknown> = {};
    if (query.type) filter.type = query.type;
    if (query.maturity) filter.maturity = query.maturity;
    if (query.tags) filter.tags = query.tags.split(',');

    const entries = store.list(filter);
    const limited = entries.slice(0, Number(query.limit) || 50);
    const result = { entries: limited, total: entries.length };
    setCache(cacheKey, result);
    return result;
  },
));

/**
 * GET /api/v1/harness/knowledge/:id
 * Get specific knowledge entry
 */
knowledgeRoutes.get('/knowledge/:id', defineRoute(
  { params: harnessIdParamsSchema },
  async (_req, _res, { params }) => {
    const store = await getKnowledgeStore();
    if (!store) throw HARNESS_UNAVAILABLE();

    const entry = store.get(params.id);
    if (!entry) throw new HttpError(404, 'NOT_FOUND', 'Knowledge entry not found');
    return entry;
  },
));

/**
 * POST /api/v1/harness/knowledge
 * Save knowledge entry
 */
knowledgeRoutes.post('/knowledge', defineRoute(
  { body: harnessKnowledgeSaveBodySchema },
  async (_req, _res, { body }) => {
    const store = await getKnowledgeStore();
    if (!store) throw HARNESS_UNAVAILABLE();

    store.save({
      id: body.id,
      title: body.title,
      content: body.content,
      type: body.type,
      tags: body.tags,
      maturity: body.maturity || 'draft',
    } as any);
    return { saved: true, id: body.id! };
  },
));

/**
 * DELETE /api/v1/harness/knowledge/:id
 * Delete knowledge entry
 */
knowledgeRoutes.delete('/knowledge/:id', defineRoute(
  { params: harnessIdParamsSchema },
  async (_req, _res, { params }) => {
    const store = await getKnowledgeStore();
    if (!store) throw HARNESS_UNAVAILABLE();

    const deleted = store.delete(params.id);
    if (!deleted) throw new HttpError(404, 'NOT_FOUND', 'Knowledge entry not found');
    return { deleted: true };
  },
));

/**
 * POST /api/v1/harness/knowledge/lint
 * Run knowledge linter
 */
knowledgeRoutes.post('/knowledge/lint', defineRoute({}, async () => {
  const loaded = await loadHarness();
  if (!loaded) throw HARNESS_UNAVAILABLE();

  const store = await getKnowledgeStore();
  if (!store) throw HARNESS_UNAVAILABLE();

  const tracker = new harnessModule!.ReferenceTracker(store);
  const linter = new harnessModule!.KnowledgeLinter(store, tracker);
  const report = linter.run();
  const issues = report.issues;

  return { issues, total: issues.length };
}));
