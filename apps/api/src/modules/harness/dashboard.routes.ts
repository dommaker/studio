/**
 * dashboard.routes — Harness 健康检查子路由（T-017）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /health     整体约束健康摘要（轻量，无 trace 文件 I/O）
 *
 * GET /dashboard 已随 harness 1.2.0 删除（ADR-0003 孤儿子系统断链，
 * 数据提供方无替代，前端零消费）。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness } from './runtime.js';

export const dashboardRoutes = Router();

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
