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
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import {
  loadHarness,
  harnessModule,
  getCached,
  setCache,
  getKnowledgeStore,
  getKnowledgeQuery,
} from './runtime.js';

export const knowledgeRoutes = Router();

// ─── Knowledge Engine (T-010) ───

/**
 * POST /api/v1/harness/knowledge/query
 * Query knowledge with token budget
 */
knowledgeRoutes.post('/knowledge/query', async (req: Request, res: Response) => {
  try {
    const query = await getKnowledgeQuery();
    if (!query) return res.status(503).json({ error: 'Harness not available' });

    const { budget, filter } = req.body;
    if (!budget) return res.status(400).json({ error: 'budget is required' });

    const result = query.query(budget, filter);
    return res.json({ data: result });
  } catch (error) {
    logger.error('Failed to query knowledge', { error: String(error) });
    return res.status(500).json({ error: 'Failed to query knowledge' });
  }
});

/**
 * GET /api/v1/harness/knowledge
 * List knowledge entries
 */
knowledgeRoutes.get('/knowledge', async (req: Request, res: Response) => {
  const cacheKey = 'knowledge_list';
  const cached = getCached<{ data: unknown[]; total: number }>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const store = await getKnowledgeStore();
    if (!store) return res.status(503).json({ error: 'Harness not available' });

    const { type, maturity, tags, limit } = req.query;
    const filter: Record<string, unknown> = {};
    if (type) filter.type = type;
    if (maturity) filter.maturity = maturity;
    if (tags) filter.tags = (tags as string).split(',');

    const entries = store.list(filter);
    const limited = entries.slice(0, Number(limit) || 50);
    const result = { data: limited, total: entries.length };
    setCache(cacheKey, result);
    return res.json(result);
  } catch (error) {
    logger.error('Failed to list knowledge', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list knowledge' });
  }
});

/**
 * GET /api/v1/harness/knowledge/:id
 * Get specific knowledge entry
 */
knowledgeRoutes.get('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const store = await getKnowledgeStore();
    if (!store) return res.status(503).json({ error: 'Harness not available' });

    const entry = store.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found' });
    return res.json({ data: entry });
  } catch (error) {
    logger.error('Failed to get knowledge', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get knowledge' });
  }
});

/**
 * POST /api/v1/harness/knowledge
 * Save knowledge entry
 */
knowledgeRoutes.post('/knowledge', async (req: Request, res: Response) => {
  try {
    const store = await getKnowledgeStore();
    if (!store) return res.status(503).json({ error: 'Harness not available' });

    const { id, title, content, type, tags, maturity } = req.body;
    if (!id || !title || !content) {
      return res.status(400).json({ error: 'id, title, and content are required' });
    }

    store.save({ id, title, content, type, tags, maturity: maturity || 'draft' } as any);
    return res.json({ saved: true, id });
  } catch (error) {
    logger.error('Failed to save knowledge', { error: String(error) });
    return res.status(500).json({ error: 'Failed to save knowledge' });
  }
});

/**
 * DELETE /api/v1/harness/knowledge/:id
 * Delete knowledge entry
 */
knowledgeRoutes.delete('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const store = await getKnowledgeStore();
    if (!store) return res.status(503).json({ error: 'Harness not available' });

    const deleted = store.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Knowledge entry not found' });
    return res.json({ deleted: true });
  } catch (error) {
    logger.error('Failed to delete knowledge', { error: String(error) });
    return res.status(500).json({ error: 'Failed to delete knowledge' });
  }
});

/**
 * POST /api/v1/harness/knowledge/lint
 * Run knowledge linter
 */
knowledgeRoutes.post('/knowledge/lint', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const store = await getKnowledgeStore();
    if (!store) return res.status(503).json({ error: 'Harness not available' });

    await loadHarness();
    const tracker = new harnessModule!.ReferenceTracker(store);
    const linter = new harnessModule!.KnowledgeLinter(store, tracker);
    const report = linter.run();
    const issues = report.issues;

    return res.json({ data: issues, total: issues.length });
  } catch (error) {
    logger.error('Failed to lint knowledge', { error: String(error) });
    return res.status(500).json({ error: 'Failed to lint knowledge' });
  }
});
