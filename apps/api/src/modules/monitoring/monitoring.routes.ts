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

export default router;
