/**
 * entries.routes — 知识条目子路由（KnowledgeStore 条目的导出/问答/缺口/统一浏览）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET  /export      B9-021: Knowledge Export API（md/json）
 * - POST /ask         §12.11b: 知识问答（检索 → LLM 生成回答）
 * - GET  /gaps/:type  G-001~005: 五大知识缺口查询
 * - GET  /gaps        五类知识统计概览
 * - GET  /unified     AS-022: 统一知识浏览
 * - POST /unified     AS-022: 手动知识条目创建
 *
 * 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
 * question/必填四件套/gaps type 词表 guard 收进 zod（原手写 400）；响应统一
 * `{ data }` 壳（原平铺 `{ answer, sources }` / `{ type, data, total }` / 裸 stats /
 * `{ entries, total }` / 201 `{ id, title, consumptionMode }`）；错误统一
 * `{ error: { code, message } }`（500 文案由固定串变为实际错误消息）。
 * GET /export 附件下载 handler 自写 res 不进壳（specs 先例）。
 */

import { Router } from 'express';
import {
  knowledgeExportQuerySchema,
  knowledgeAskBodySchema,
  knowledgeGapParamsSchema,
  knowledgeGapQuerySchema,
  unifiedKnowledgeQuerySchema,
  createUnifiedEntryBodySchema,
} from '@dommaker/studio-contract';
import { sharedStore, publishKnowledgeEntryChanged } from './knowledge-singletons.js';
// P2-c 拆环：getSystemExecutor 转函数内动态 import（knowledge→agents 静态边清零）
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { parsePagination } from '../../utils/pagination.js';
import { defineRoute } from '../../core/http.js';

export const entriesRoutes = Router();

// ============================================
// B9-021: Knowledge Export API
// Uses sharedStore directly — KnowledgeService.list() wraps the same store
// ============================================

/**
 * GET /api/v1/knowledge/export
 * Query: format=md|json, types=guideline,pitfall (comma-separated), limit（默认 20，上限 100 — #359 起统一 parsePagination，原缺省 100 无 clamp）
 * 附件下载（md/json）：handler 自写 res 不进 `{ data }` 壳（specs export 先例）
 */
entriesRoutes.get('/export', defineRoute({ query: knowledgeExportQuerySchema }, async (req, res, { query }) => {
  const { sharedStore } = await import('./knowledge-singletons.js');
  const format = query.format === 'json' ? 'json' : 'md';
  const types = query.types ? query.types.split(',').filter(Boolean) : undefined;
  const { limit } = parsePagination(req);

  const entries = sharedStore.list({ types: types as any }).slice(0, limit);
  const content = format === 'json'
    ? JSON.stringify(entries, null, 2)
    : entries.map((e: any) => `# ${e.title || e.id}\n\n${e.content}`).join('\n\n---\n\n');

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
  } else {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="knowledge-export.md"');
  }
  res.send(content);
}));

// ============================================
// §12.11b: 知识问答 API
// ============================================

/**
 * POST /api/v1/knowledge/ask
 * 知识问答：检索相关知识条目 → LLM 生成回答
 *
 * Body: { question: string, types?: string[], limit?: number }
 * Returns: { data: { answer: string, sources: Array<{ id, title, type }> } }
 */
entriesRoutes.post('/ask', requireAuth(), requireNotGuest(), defineRoute(
  { body: knowledgeAskBodySchema },
  async (_req, _res, { body }) => {
    const { question, types, limit = 10 } = body;

    // 1. Retrieve relevant entries from KnowledgeStore
    const allEntries = sharedStore.list({ types: types as any }).slice(0, 100);
    // Simple keyword matching on title + content
    const keywords = question.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = allEntries
      .map((e: any) => {
        const text = `${e.title || ''} ${e.content}`.toLowerCase();
        const hits = keywords.filter((k: string) => text.includes(k)).length;
        return { entry: e, score: hits };
      })
      .filter((s: any) => s.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) {
      return { answer: '未找到相关知识条目。', sources: [] };
    }

    // 2. Format context for LLM
    const entries = scored.map((s: any) => s.entry);
    const contextLines = entries.map((e: any, i: number) =>
      `[${i + 1}] ${e.title || '(无标题)'} (${e.type})\n${e.content}`
    );
    const context = contextLines.join('\n\n---\n\n');

    // 3. LLM call
    const systemPrompt = '你是知识库问答助手。根据提供的知识条目回答用户问题。回答必须基于知识条目内容，不要编造。引用时标注来源编号如 [1] [2]。';
    const userPrompt = `知识条目：\n${context}\n\n---\n\n用户问题：${question}`;

    const answer = (await (await import('../agents/index.js')).getSystemExecutor().run(userPrompt, { systemPrompt, eventSource: 'knowledge-qa' })).output;

    // 4. Return answer + source references
    const sources = entries.map((e: any) => ({
      id: e.id,
      title: e.title || e.content.slice(0, 60),
      type: e.type,
    }));

    return { answer, sources };
  },
));

// ============================================
// G-001~005: 五大知识缺口查询 API
// ============================================

/**
 * GET /api/v1/knowledge/gaps/:type
 * 查询五种知识类型: preference | business_rule | environment | decision_chain | interaction
 * （非法 type 原手写 400 → zod enum 400，文案变 zod 格式）
 */
entriesRoutes.get('/gaps/:type', defineRoute(
  { params: knowledgeGapParamsSchema, query: knowledgeGapQuerySchema },
  async (req, _res, { params, query }) => {
    const { type } = params;

    const { knowledgeQuery } = await import('./knowledge-query.service.js');
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

/**
 * GET /api/v1/knowledge/gaps
 * 获取所有五种知识类型的统计概览
 */
entriesRoutes.get('/gaps', defineRoute({}, async () => {
  const { knowledgeQuery } = await import('./knowledge-query.service.js');
  return knowledgeQuery.getStats();
}));

// ── AS-022: Unified Knowledge API ─────────────────────────

// Lazy-load UnifiedQuery to avoid circular deps
let _uq: InstanceType<typeof import('./engine/unified-query.js').UnifiedQuery> | null = null;
async function getUnifiedQuery() {
  if (!_uq) {
    const { UnifiedQuery } = await import('./engine/unified-query.js');
    _uq = new UnifiedQuery();
  }
  return _uq;
}

/**
 * GET /unified — unified knowledge browser
 * Query params: consumptionMode, tags, origin, maturity, limit（默认 20，上限 100 — #359 起统一 parsePagination，原缺省 50）, offset, sortBy
 */
entriesRoutes.get('/unified', defineRoute({ query: unifiedKnowledgeQuerySchema }, async (req, _res, { query }) => {
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
entriesRoutes.post('/unified', requireAuth(), requireNotGuest(), defineRoute(
  { body: createUnifiedEntryBodySchema },
  { status: 201 },
  async (req, _res, { body }) => {
    const { type, title, content, consumptionMode, applicableAgents, tags } = body;

    const { sharedStore } = await import('./knowledge-singletons.js');
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
      sourceReferences: [{ source: `manual:${operator}`, timestamp: now }] as any,
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
