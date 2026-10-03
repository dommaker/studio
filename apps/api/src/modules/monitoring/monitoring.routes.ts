// Monitoring Routes — Agent Network (MVP-2 + MVP-6 + D16)
//
// 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——响应统一
// `{ data }` 壳（原裸对象进壳）；错误统一 `{ error: { code, message } }`
//（原手写 500 已同形，code 由 'INTERNAL_ERROR' 归一为 ERROR_CODES.INTERNAL，
// message 文案不变 = 实际错误消息）。windowDays 缺省/clamp 逻辑保持原样。
import { Router } from 'express';
import { MonitoringService } from './monitoring.service.js';
import { MetricsService } from './metrics.service.js';
import { defineRoute } from '../../core/http.js';
import { monitoringWindowQuerySchema } from '@dommaker/studio-contract';

const router = Router();
const service = new MonitoringService();
const metricsService = new MetricsService();

/** windowDays 解析（缺省 7 由 service 层落；1-90 clamp；非数值 → undefined 走缺省） */
function parseWindowDays(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 1), 90) : undefined;
}

/** GET /agents — AgentProfile + RuntimeInstance aggregation */
router.get('/agents', defineRoute({}, async () => service.getAgentSummary()));

/** GET /stats — WorkUnit + Agent + recent stats aggregation */
router.get('/stats', defineRoute({}, async () => service.getStats()));

/** GET /flywheel — M1: 飞轮指标（hitRate/quality/freshness/proposal 待审/提取活动） */
router.get('/flywheel', defineRoute({}, async () => service.getFlywheelStats()));

/** GET /overhead — M2: 封装开销（注入 tokens vs 2K 红线 / 开销比 vs 1.2x 红线 / 提取 tokens） */
router.get('/overhead', defineRoute({}, async () => service.getOverheadStats()));

/**
 * GET /overview — D16: 监控指标聚合（任务流健康/入口转化/人工干预北极星/端到端周期/
 * 角色维度/工程质量/Token/告警）。Query: windowDays（默认 7，1-90 clamp）。60s 缓存。
 */
router.get('/overview', defineRoute(
  { query: monitoringWindowQuerySchema },
  async (_req, _res, { query }) => metricsService.getOverviewMetrics({ windowDays: parseWindowDays(query.windowDays) }),
));

/**
 * GET /efficiency — #120: 输入缓存命中率（步/WU/角色/天）+ 段 trim 率（按段）。
 * Query: windowDays（默认 7，1-90 clamp）。60s 缓存。
 */
router.get('/efficiency', defineRoute(
  { query: monitoringWindowQuerySchema },
  async (_req, _res, { query }) => metricsService.getEfficiencyMetrics({ windowDays: parseWindowDays(query.windowDays) }),
));

export default router;
