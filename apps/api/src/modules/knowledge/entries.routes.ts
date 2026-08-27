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
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { sharedStore } from './knowledge-bus.service.js';
import { getSystemExecutor } from '../agents/system-executor.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { parsePagination } from '../../utils/pagination.js';

export const entriesRoutes = Router();

// ============================================
// B9-021: Knowledge Export API
// Uses sharedStore directly — KnowledgeService.list() wraps the same store
// ============================================

/**
 * GET /api/v1/knowledge/export
 * Query: format=md|json, types=guideline,pitfall (comma-separated), limit（默认 20，上限 100 — #359 起统一 parsePagination，原缺省 100 无 clamp）
 */
entriesRoutes.get('/export', async (req, res) => {
  try {
    const { sharedStore } = await import('./knowledge-bus.service.js');
    const format = (req.query.format as string) === 'json' ? 'json' : 'md';
    const types = req.query.types ? (req.query.types as string).split(',').filter(Boolean) : undefined;
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
  } catch (error) {
    logger.error('Failed to export knowledge');
    res.status(500).json({ error: 'Failed to export knowledge' });
  }
});

// ============================================
// §12.11b: 知识问答 API
// ============================================

/**
 * POST /api/v1/knowledge/ask
 * 知识问答：检索相关知识条目 → LLM 生成回答
 *
 * Body: { question: string, types?: string[], limit?: number }
 * Returns: { answer: string, sources: Array<{ id, title, type }> }
 */
entriesRoutes.post('/ask', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const { question, types, limit = 10 } = req.body;
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' });
    }

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
      return res.json({ answer: '未找到相关知识条目。', sources: [] });
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

    const answer = (await getSystemExecutor().run(userPrompt, { systemPrompt, eventSource: 'knowledge-qa' })).output;

    // 4. Return answer + source references
    const sources = entries.map((e: any) => ({
      id: e.id,
      title: e.title || e.content.slice(0, 60),
      type: e.type,
    }));

    res.json({ answer, sources });
  } catch (error) {
    logger.error('Knowledge ask failed');
    res.status(500).json({ error: 'Knowledge ask failed' });
  }
});

// ============================================
// G-001~005: 五大知识缺口查询 API
// ============================================

/**
 * GET /api/v1/knowledge/gaps/:type
 * 查询五种知识类型: preference | business_rule | environment | decision_chain | interaction
 */
entriesRoutes.get('/gaps/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['preference', 'business_rule', 'environment', 'decision_chain', 'interaction'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    }

    const { knowledgeQuery } = await import('./knowledge-query.service.js');
    const data = await knowledgeQuery.query({
      type: type as any,
      topic: req.query.topic as string,
      category: req.query.category as string,
      // #359：统一 parsePagination（clamp 1..100），缺省 20 与既有口径一致
      limit: parsePagination(req).limit,
    });
    return res.json({ type, data, total: data.length });
  } catch (error) {
    logger.error('Failed to query knowledge gaps');
    return res.status(500).json({ error: 'Failed to query knowledge gaps' });
  }
});

/**
 * GET /api/v1/knowledge/gaps
 * 获取所有五种知识类型的统计概览
 */
entriesRoutes.get('/gaps', async (req, res) => {
  try {
    const { knowledgeQuery } = await import('./knowledge-query.service.js');
    const stats = await knowledgeQuery.getStats();
    return res.json(stats);
  } catch (error) {
    logger.error('Failed to get knowledge gap stats');
    return res.status(500).json({ error: 'Failed to get knowledge gap stats' });
  }
});

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
entriesRoutes.get('/unified', async (req, res) => {
  try {
    const uq = await getUnifiedQuery();
    const filter = {
      consumptionModes: req.query.consumptionMode ? String(req.query.consumptionMode).split(',') : undefined,
      tags: req.query.tags ? String(req.query.tags).split(',') : undefined,
      origins: req.query.origin ? String(req.query.origin).split(',') : undefined,
      maturity: req.query.maturity ? String(req.query.maturity).split(',') : undefined,
      excludeTags: ['low_quality'],
      limit: parsePagination(req).limit,
      offset: req.query.offset ? Number(req.query.offset) : 0,
      sortBy: req.query.sortBy as any || 'lastReferenced',
      sources: ['store' as const],
    };
    const result = await uq.listEntries(filter);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Query failed', detail: String(error) });
  }
});

/**
 * POST /unified — manual knowledge entry creation
 * Body: { type, title, content, consumptionMode, applicableAgents?, tags? }
 */
entriesRoutes.post('/unified', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const { type, title, content, consumptionMode, applicableAgents, tags } = req.body;

    if (!type || !title || !content || !consumptionMode) {
      res.status(400).json({ error: 'Missing required fields: type, title, content, consumptionMode' });
      return;
    }

    const { sharedStore } = await import('./knowledge-bus.service.js');
    const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    // #93：人工创建本身就是出处凭证——不 stamp 的话 hasSourceReferences 闸门会永远拦住该条目
    const operator = (req as any).user?.id ?? 'unknown';

    // Store applicableAgents in tags (KnowledgeEntry doesn't have applicableAgents field)
    const entryTags = [...(tags || []), ...(applicableAgents || []).map((a: string) => `agent:${a}`)];

    sharedStore.save({
      id,
      type,
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
      consumptionMode,
      origin: 'human',
    });

    res.status(201).json({ id, title, consumptionMode });
  } catch (error) {
    res.status(500).json({ error: 'Creation failed', detail: String(error) });
  }
});
