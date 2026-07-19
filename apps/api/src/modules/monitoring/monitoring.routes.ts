// Monitoring Routes — Agent Network (MVP-2 + MVP-6)
import { Router, type Request, type Response } from 'express';
import { MonitoringService } from './monitoring.service.js';

const router = Router();
const service = new MonitoringService();

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

export default router;
