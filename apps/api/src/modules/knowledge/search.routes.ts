/**
 * search.routes — 知识检索与解法指标子路由
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /resolutions              S11: 解法浏览（status/errorClass/layer/search 过滤）
 * - GET /search                   S11: 统一检索（apiCache 中间件保留在本路由上）
 * - GET /resolution/density       RKB Phase 2: 知识密度评分
 * - GET /resolution/cross-session RKB Phase 2: 跨会话因果关系统计
 *
 * 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
 * q 必填 guard 收进 zod（原手写 400）；响应统一 `{ data }` 壳（原平铺
 * `{ resolutions, total, byStatus }` / `{ results, total }` / 裸 density/cross-session
 * 对象）；错误统一 `{ error: { code, message } }`（500 文案由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { listResolutionsQuerySchema, knowledgeSearchQuerySchema } from '@dommaker/studio-contract';
import { resolutionService } from './resolution.service.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { defineRoute } from '../../core/http.js';

export const searchRoutes = Router();

// ============================================
// S11: Resolution browsing + unified search
// ============================================

/**
 * GET /api/v1/knowledge/resolutions
 * Query: status, errorClass, layer, search, limit, offset
 */
searchRoutes.get('/resolutions', defineRoute({ query: listResolutionsQuerySchema }, async (_req, _res, { query }) => {
  const { status, errorClass, layer, search, limit = '50', offset = '0' } = query;
  const where: Record<string, unknown> = {};
  if (status) where.status = String(status);
  if (errorClass) where.errorClass = String(errorClass);
  if (layer) where.layer = String(layer);
  if (search) {
    where.OR = [
      { title: { contains: String(search) } },
      { fix: { contains: String(search) } },
      { pattern: { contains: String(search) } },
    ];
  }

  // R3: 解法库浏览口径 = draft + proven（proven 是审核通过的正式解法，本应展示）
  // M1：口径自 pending/canonical 迁至 draft/proven（harness schema 合法值）
  const allResolutions = await resolutionService.listByMaturity(['draft', 'proven']); // TODO: add search support to resolutionService
  // Simple in-memory filter for search
  let resolutions = allResolutions;
  if (search) {
    const q = String(search).toLowerCase();
    resolutions = resolutions.filter((r: any) =>
      (r.title && r.title.toLowerCase().includes(q)) ||
      (r.fix && r.fix.toLowerCase().includes(q)) ||
      (r.pattern && r.pattern.toLowerCase().includes(q))
    );
  }
  const total = allResolutions.length; // FIXME: count after filter, not before search
  resolutions = resolutions.slice(Number(offset), Number(offset) + Math.min(Number(limit), 100));

  const byStatus: Record<string, number> = {};
  for (const r of allResolutions) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  return {
    resolutions,
    total: resolutions.length,
    byStatus,
  };
}));

/**
 * GET /api/v1/knowledge/search
 * Unified search across all knowledge types
 * Query: q (required), types (comma-separated: resolution,pattern,knowledge)
 * R4: behavior 读端已删（写链路整体已清理，全库无写入方，属残尸）
 * #149（2026-08-15）：document 源随 document-store 退役移除。
 * （q 必填原手写 400 → zod 400）
 */
searchRoutes.get('/search', apiCache(CACHE_CONFIG.short), defineRoute({ query: knowledgeSearchQuerySchema }, async (_req, _res, { query }) => {
  const { q, types, limit = '20' } = query;
  const searchQuery = String(q).toLowerCase();
  const searchTypes = types ? String(types).split(',') : ['resolution', 'pattern'];
  const takeLimit = Math.min(Number(limit), 50);

  const results: Array<{ type: string; id: string; title: string; snippet: string; score: number }> = [];

  // Search resolutions（R3: 同浏览口径 draft + proven，proven 命中加分）
  if (searchTypes.includes('resolution')) {
    const allRes = await resolutionService.listByMaturity(['draft', 'proven']); // FIXME: need listAll or search method
    const resolutions = allRes.filter((r: any) =>
      (r.title && r.title.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (r.fix && r.fix.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (r.pattern && r.pattern.toLowerCase().includes(searchQuery.toLowerCase()))
    ).slice(0, takeLimit);
    for (const r of resolutions) {
      const titleLower = r.title.toLowerCase();
      const score = titleLower.includes(searchQuery) ? 3 : 1;
      results.push({
        type: 'resolution',
        id: r.id,
        title: r.title,
        snippet: r.fix.slice(0, 200),
        score: score + (r.status === 'proven' ? 1 : 0),
      });
    }
  }

  // Search interaction patterns (KnowledgeStore)
  if (searchTypes.includes('pattern')) {
    const { sharedStore } = await import('./knowledge-singletons.js');
    const { listInteractionPatterns, parsePatternContent } = await import('./pattern-entry.js');
    const patterns = listInteractionPatterns(sharedStore, ['active'])
      .filter((e) => {
        const d = parsePatternContent(e.content);
        if (d === null) return false; // 正文损坏条目跳过（见 pattern-entry.ts 根因注释）
        const name = e.title || '';
        const desc = String(d.description || '');
        const insight = String(d.insight || '');
        return name.includes(searchQuery) || desc.includes(searchQuery) || insight.includes(searchQuery);
      })
      .slice(0, takeLimit);
    for (const e of patterns) {
      const d = parsePatternContent(e.content) ?? {};
      results.push({
        type: 'pattern',
        id: e.id,
        title: e.title,
        snippet: String(d.insight || d.description || '').slice(0, 200),
        score: 2,
      });
    }
  }

  // AS-019: Search KnowledgeStore entries (file-based knowledge)
  if (searchTypes.includes('knowledge') || searchTypes.includes('store')) {
    try {
      const { knowledgeService } = await import('./knowledge-service.js');
      const kbResults = await knowledgeService.search(String(q), { mode: 'keyword', limit: takeLimit });
      for (const r of kbResults) {
        results.push({
          type: 'knowledge',
          id: r.entry.id,
          title: r.entry.title,
          snippet: (r.highlights[0] ?? '').slice(0, 200),
          score: r.score,
        });
      }
      // knowledge:search_hit 埋点保持（monitor-reports 知识指标消费；#343 前
      // 由 KnowledgeBus.search 内联发射，现统一在唯一消费入口补齐）
      if (kbResults.length > 0) {
        const { appendKnowledgeEvent } = await import('./knowledge-singletons.js');
        const avgScore = kbResults.reduce((s, r) => s + r.score, 0) / kbResults.length;
        appendKnowledgeEvent('knowledge:search_hit', {
          query: String(q).slice(0, 200),
          hitCount: kbResults.length,
          avgScore: Math.round(avgScore * 100) / 100,
          entryIds: kbResults.map(r => r.entry.id),
        });
      }
    } catch { /* non-blocking */ }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return { results: results.slice(0, takeLimit), total: results.length };
}));

// ============================================
// RKB Phase 2: Knowledge density + cross-session + auto-verify
// ============================================

/**
 * GET /api/v1/knowledge/resolution/density
 * Knowledge density score (0-100) based on coverage, verification, breadth
 */
searchRoutes.get('/resolution/density', defineRoute({}, async () => {
  const { resolutionService } = await import('./resolution.service.js');
  return resolutionService.getDensityScore();
}));

/**
 * GET /api/v1/knowledge/resolution/cross-session
 * Cross-session causality stats: goal-linked vs unlinked resolutions
 */
searchRoutes.get('/resolution/cross-session', defineRoute({}, async () => {
  const { resolutionService } = await import('./resolution.service.js');
  return resolutionService.getCrossSessionStats();
}));
