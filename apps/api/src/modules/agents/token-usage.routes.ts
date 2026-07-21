/**
 * §10.5 角色级 token 视图路由（只读）。
 *
 *   GET /api/v1/agents/:id/token-usage — 按 profile 聚合 workunit:tokens 事件
 *
 * 挂在 /api/v1/agents 前缀下（route-registry 中先于 legacy agentRoutes 注册，
 * 只处理 /:id/token-usage，其余路径自然落到 legacy 路由）。
 */

import { Router, type Request, type Response } from 'express';
import { getAgentTokenUsage } from './token-usage.service.js';
import { getErrorMessage } from '../../utils/errors.js';

const router = Router();

/** GET /:id/token-usage — profile 级 token 聚合（空数据返回全零，不抛错） */
router.get('/:id/token-usage', async (req: Request, res: Response) => {
  try {
    const usage = await getAgentTokenUsage(req.params.id);
    res.json(usage);
  } catch (error) {
    // 服务层已保证不抛；这里兜底防御
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

export default router;
