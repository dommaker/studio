/**
 * dashboard.routes — Harness 仪表盘与健康检查子路由（T-017）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /dashboard  完整仪表盘数据
 * - GET /health     整体约束健康摘要（轻量，无 trace 文件 I/O）
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule, getKnowledgeStore } from './runtime.js';

export const dashboardRoutes = Router();

// ─── Dashboard (T-017) ───

/**
 * GET /api/v1/harness/dashboard
 * Full dashboard data
 */
dashboardRoutes.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    await loadHarness();
    const provider = new harnessModule!.DashboardDataProvider();

    // Get knowledge entries from store
    const store = await getKnowledgeStore();
    const entries = store ? store.list() : [];

    const dashboard = provider.generate(entries);
    return res.json({ data: dashboard });
  } catch (error) {
    logger.error('Failed to generate dashboard', { error: String(error) });
    return res.status(500).json({ error: 'Failed to generate dashboard' });
  }
});

/**
 * GET /api/v1/harness/health
 * Overall constraint health summary
 */
dashboardRoutes.get('/health', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available', status: 'unknown' });

    // Lightweight health: no trace file I/O, just connection check
    return res.json({
      status: 'ok',
      harness: 'connected',
      constraintsActive: true,
    });
  } catch (error) {
    logger.error('Failed to get harness health', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get health status' });
  }
});
