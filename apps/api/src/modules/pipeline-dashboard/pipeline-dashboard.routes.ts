/**
 * Dogfood Status Dashboard — GET /api/v1/dogfood/status
 *
 * @deprecated Pipeline（Goal 系统）已废弃，由 Agent Network 替代。
 * 端点保留返回 503，Phase 4 删除整个 pipeline-dashboard/ 模块。
 */
import { Router } from 'express';

const router = Router();

router.get('/status', (_req, res) => {
  res.status(503).json({
    error: 'Pipeline deprecated',
    detail: 'Pipeline（Goal 系统）已废弃，由 Agent Network（WorkUnit 系统）替代。此端点将在 Phase 4 删除。',
  });
});

export default router;
