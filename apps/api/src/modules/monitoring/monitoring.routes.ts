// Monitoring Routes — Agent Network (MVP-2 + MVP-6 + D16)
import { Router, type Request, type Response } from 'express';
import { MonitoringService } from './monitoring.service.js';
import { MetricsService } from './metrics.service.js';

const router = Router();
const service = new MonitoringService();
const metricsService = new MetricsService();

/** GET /agents — AgentProfile + RuntimeInstance aggregation */
router.get('/agents', async (_req: Request, res: Response) => {
  try {
    const result = await service.getAgentSummary();
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** GET /stats — WorkUnit + Agent + recent stats aggregation */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const result = await service.getStats();
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** GET /flywheel — M1: 飞轮指标（hitRate/quality/freshness/proposal 待审/提取活动） */
router.get('/flywheel', async (_req: Request, res: Response) => {
  try {
    const result = await service.getFlywheelStats();
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** GET /overhead — M2: 封装开销（注入 tokens vs 2K 红线 / 开销比 vs 1.2x 红线 / 提取 tokens） */
router.get('/overhead', async (_req: Request, res: Response) => {
  try {
    const result = await service.getOverheadStats();
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/**
 * GET /overview — D16: 监控指标聚合（任务流健康/入口转化/人工干预北极星/端到端周期/
 * 角色维度/工程质量/Token/告警）。Query: windowDays（默认 7，1-90 clamp）。60s 缓存。
 */
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const raw = Number(req.query.windowDays);
    const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(Math.floor(raw), 1), 90) : undefined;
    const result = await metricsService.getOverviewMetrics({ windowDays });
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/**
 * GET /efficiency — #120: 输入缓存命中率（步/WU/角色/天）+ 段 trim 率（按段）。
 * Query: windowDays（默认 7，1-90 clamp）。60s 缓存。
 */
router.get('/efficiency', async (req: Request, res: Response) => {
  try {
    const raw = Number(req.query.windowDays);
    const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(Math.floor(raw), 1), 90) : undefined;
    const result = await metricsService.getEfficiencyMetrics({ windowDays });
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

export default router;
