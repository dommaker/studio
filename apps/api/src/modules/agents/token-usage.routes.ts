/**
 * §10.5 角色级 token 视图路由（只读）。
 *
 *   GET /api/v1/agents/:id/token-usage — 按 profile 聚合 workunit:tokens 事件
 *
 * 挂在 /api/v1/agents 前缀下（route-registry 中先于 legacy agentRoutes 注册，
 * 只处理 /:id/token-usage，其余路径自然落到 legacy 路由）。
 *
 * 契约驱动迁移（2026-10 批次 8/8）：defineRoute 化——裸聚合响应统一 `{ data }` 壳
 * （无前端消费方）；500 code 'INTERNAL_ERROR' 归一 INTERNAL。
 */

import { Router } from 'express';
import { agentTokenUsageParamsSchema } from '@dommaker/studio-contract';
import { getAgentTokenUsage } from './token-usage.service.js';
import { defineRoute } from '../../core/http.js';

const router = Router();

/** GET /:id/token-usage — profile 级 token 聚合（空数据返回全零，不抛错） */
router.get('/:id/token-usage', defineRoute({ params: agentTokenUsageParamsSchema }, async (_req, _res, { params }) => {
  // 服务层已保证不抛；defineRoute 500 兜底防御
  return getAgentTokenUsage(params.id);
}));

export default router;
