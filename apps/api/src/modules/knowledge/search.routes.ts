/**
 * search.routes — 知识检索与解法指标子路由
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /resolutions              S11: 解法浏览（status/errorClass/layer/search 过滤）
 * - GET /search                   S11: 统一检索（apiCache 中间件保留在本路由上）
 * - GET /resolution/density       RKB Phase 2: 知识密度评分
 * - GET /resolution/cross-session RKB Phase 2: 跨会话因果关系统计
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { resolutionService } from './resolution.service.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { listDocs } from './document-store.js';

export const searchRoutes = Router();

// ============================================
// S11: Resolution browsing + unified search
// ============================================

/**
 * GET /api/v1/knowledge/resolutions
 * Query: status, errorClass, layer, search, limit, offset
 */
searchRoutes.get('/resolutions', async (req, res) => {
  try {
    const { status, errorClass, layer, search, limit = '50', offset = '0' } = req.query;
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

    const allResolutions = await resolutionService.listPending(); // TODO: add search support to resolutionService
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

    res.json({
      resolutions,
      total: resolutions.length,
      byStatus,
    });
  } catch (error) {
    logger.error('Failed to list resolutions');
    res.status(500).json({ error: 'Failed to list resolutions' });
  }
});

/**
 * GET /api/v1/knowledge/search
 * Unified search across all knowledge types
 * Query: q (required), types (comma-separated: document,resolution,behavior,pattern)
 */
searchRoutes.get('/search', apiCache(CACHE_CONFIG.short), async (req, res) => {
  try {
    const { q, types, limit = '20' } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'q (search query) is required' });
    }
    const query = String(q).toLowerCase();
    const searchTypes = types ? String(types).split(',') : ['document', 'resolution', 'behavior', 'pattern'];
    const takeLimit = Math.min(Number(limit), 50);

    const results: Array<{ type: string; id: string; title: string; snippet: string; score: number }> = [];

    // Search documents (FileStore)
    if (searchTypes.includes('document')) {
      const allDocs = await listDocs();
      const matched = allDocs
        .filter(d => d.title.toLowerCase().includes(query) || d.content.toLowerCase().includes(query))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, takeLimit);
      for (const d of matched) {
        const titleLower = d.title.toLowerCase();
        const score = titleLower.includes(query) ? 3 : 1;
        results.push({
          type: 'document',
          id: d.id,
          title: d.title,
          snippet: (d.content || '').slice(0, 200),
          score,
        });
      }
    }

    // Search resolutions
    if (searchTypes.includes('resolution')) {
      const allRes = await resolutionService.listPending(); // FIXME: need listAll or search method
      const resolutions = allRes.filter((r: any) =>
        (r.title && r.title.toLowerCase().includes(query.toLowerCase())) ||
        (r.fix && r.fix.toLowerCase().includes(query.toLowerCase())) ||
        (r.pattern && r.pattern.toLowerCase().includes(query.toLowerCase()))
      ).slice(0, takeLimit);
      for (const r of resolutions) {
        const titleLower = r.title.toLowerCase();
        const score = titleLower.includes(query) ? 3 : 1;
        results.push({
          type: 'resolution',
          id: r.id,
          title: r.title,
          snippet: r.fix.slice(0, 200),
          score: score + (r.status === 'canonical' ? 1 : 0),
        });
      }
    }

    // Search behavior profiles (KnowledgeStore)
    if (searchTypes.includes('behavior')) {
      const { sharedStore: bSearchStore } = await import('./knowledge-bus.service.js');
      const behaviorSearchEntries = bSearchStore.list({ tags: ['behavior'] })
        .filter((e: any) => {
          const d = JSON.parse(e.content || '{}');
          const title = e.title || '';
          const pattern = d.pattern || '';
          const evidence = d.evidence || '';
          return title.includes(query) || pattern.includes(query) || evidence.includes(query);
        })
        .slice(0, takeLimit);
      for (const e of behaviorSearchEntries) {
        const d = JSON.parse((e as any).content || '{}');
        results.push({
          type: 'behavior',
          id: (e as any).id,
          title: (e as any).title,
          snippet: (d.pattern || '').slice(0, 200),
          score: 1,
        });
      }
    }

    // Search interaction patterns (KnowledgeStore)
    if (searchTypes.includes('pattern')) {
      const { sharedStore } = await import('./knowledge-bus.service.js');
      const patterns = sharedStore.list({ tags: ['pattern', 'active'] })
        .filter((e: any) => {
          const d = JSON.parse(e.content || '{}');
          const name = e.title || '';
          const desc = d.description || '';
          const insight = d.insight || '';
          return name.includes(query) || desc.includes(query) || insight.includes(query);
        })
        .slice(0, takeLimit);
      for (const e of patterns) {
        const d = JSON.parse((e as any).content || '{}');
        results.push({
          type: 'pattern',
          id: (e as any).id,
          title: (e as any).title,
          snippet: (d.insight || d.description || '').slice(0, 200),
          score: 2,
        });
      }
    }

    // AS-019: Search KnowledgeStore entries (file-based knowledge)
    if (searchTypes.includes('knowledge') || searchTypes.includes('store')) {
      try {
        const { knowledgeBus } = await import('./knowledge-bus.service.js');
        const kbResults = knowledgeBus.search(String(q), { limit: takeLimit });
        for (const r of kbResults) {
          results.push({
            type: 'knowledge',
            id: r.id,
            title: r.title,
            snippet: r.matchContext.slice(0, 200),
            score: r.score,
          });
        }
      } catch { /* non-blocking */ }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    res.json({ results: results.slice(0, takeLimit), total: results.length });
  } catch (error) {
    logger.error('Knowledge search failed');
    res.status(500).json({ error: 'Knowledge search failed' });
  }
});

// ============================================
// RKB Phase 2: Knowledge density + cross-session + auto-verify
// ============================================

/**
 * GET /api/v1/knowledge/resolution/density
 * Knowledge density score (0-100) based on coverage, verification, breadth
 */
searchRoutes.get('/resolution/density', async (_req, res) => {
  try {
    const { resolutionService } = await import('./resolution.service.js');
    const density = await resolutionService.getDensityScore();
    res.json(density);
  } catch (error) {
    logger.error('Failed to get density score');
    res.status(500).json({ error: 'Failed to get density score' });
  }
});

/**
 * GET /api/v1/knowledge/resolution/cross-session
 * Cross-session causality stats: goal-linked vs unlinked resolutions
 */
searchRoutes.get('/resolution/cross-session', async (_req, res) => {
  try {
    const { resolutionService } = await import('./resolution.service.js');
    const stats = await resolutionService.getCrossSessionStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get cross-session stats');
    res.status(500).json({ error: 'Failed to get cross-session stats' });
  }
});
