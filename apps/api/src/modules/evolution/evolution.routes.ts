/**
 * E1 约束进化 API（vision §6）。
 *
 *   GET  /api/v1/evolution/proposals?status=&targetType=   提案列表
 *   GET  /api/v1/evolution/proposals/:id                   单个提案
 *   POST /api/v1/evolution/proposals/:id/approve           批准并生效（body: { reason?, decidedBy? }）
 *   POST /api/v1/evolution/proposals/:id/reject            拒绝（body: { reason? }）
 *   POST /api/v1/evolution/run                             手动触发一轮提案生成
 *
 * 决策路径与频道回复（approve/reject EP-XXXX）共用 EvolutionService.decide —— 同一幂等语义。
 */
import { Router, type Request, type Response } from 'express';
import { EvolutionError, EvolutionService, getEvolutionService } from './evolution.service.js';

export function createEvolutionRoutes(service?: EvolutionService): Router {
  const router = Router();
  const svc = (): EvolutionService => service ?? getEvolutionService();

  const handleError = (err: unknown, res: Response): void => {
    if (err instanceof EvolutionError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 500;
      res.status(status).json({ success: false, error: err.message });
      return;
    }
    throw err;
  };

  router.get('/proposals', async (req: Request, res: Response) => {
    const { status, targetType } = req.query;
    const data = await svc().list({
      ...(typeof status === 'string' && status ? { status } : {}),
      ...(typeof targetType === 'string' && targetType ? { targetType } : {}),
    });
    res.json({ success: true, data });
  });

  router.get('/proposals/:id', async (req: Request, res: Response) => {
    const data = await svc().get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: `Evolution proposal not found: ${req.params.id}` });
    res.json({ success: true, data });
  });

  router.post('/proposals/:id/approve', async (req: Request, res: Response) => {
    try {
      const decidedBy = typeof req.body?.decidedBy === 'string' && req.body.decidedBy
        ? req.body.decidedBy
        : `api:${(req as Request & { user?: { name?: string } }).user?.name ?? 'local'}`;
      const data = await svc().decide(req.params.id, 'approve', {
        decidedBy,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      });
      res.json({ success: true, data });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/proposals/:id/reject', async (req: Request, res: Response) => {
    try {
      const data = await svc().decide(req.params.id, 'reject', {
        decidedBy: `api:${(req as Request & { user?: { name?: string } }).user?.name ?? 'local'}`,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      });
      res.json({ success: true, data });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/run', async (_req: Request, res: Response) => {
    const data = await svc().runScan();
    res.json({ success: true, data });
  });

  return router;
}

export default createEvolutionRoutes();
