/**
 * dashboard.routes — Harness 健康检查子路由（T-017）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /health     整体约束健康摘要（轻量，无 trace 文件 I/O）
 *
 * GET /dashboard 已随 harness 1.2.0 删除（ADR-0003 孤儿子系统断链，
 * 数据提供方无替代，前端零消费）。
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * 裸对象进 `{ data }` 壳；503 `{ error, status: 'unknown' }` 统一为
 * `{ error: { code: SERVICE_UNAVAILABLE, message } }`（status 兄弟键退役）；
 * 500 message 由固定串变为实际错误消息。
 */

import { Router } from 'express';
import { defineRoute, HttpError } from '../../core/http.js';
import { loadHarness } from './runtime.js';

export const dashboardRoutes = Router();

/**
 * GET /api/v1/harness/health
 * Overall constraint health summary
 */
dashboardRoutes.get('/health', defineRoute({}, async () => {
  const loaded = await loadHarness();
  if (!loaded) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Harness not available');

  // Lightweight health: no trace file I/O, just connection check
  return {
    status: 'ok',
    harness: 'connected',
    constraintsActive: true,
  };
}));
