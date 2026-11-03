/**
 * RuntimeInstance terminate 路由 (AS-026 AC-1)
 *
 * Phase 4 批5（2026-10-17）：管理面 4 条孤儿端点删除（GET /、POST /、GET /:id、
 * PATCH /:id——零消费方：ops roster 走 service 与 /monitoring/agents；agent-loop 经
 * service 建实例），agent-instance.service 本体保留（ops/instance-timeout-scan、
 * workunit-review 直调）。本文件只剩 terminate 一个活端点：
 *
 *   POST   /api/v1/agent-instances/:id/terminate — 强制停止：unclaim + WorkUnit 置 blocked 转人工 + 实例 terminated
 *
 * 鉴权：terminate 归 admin entry（registry 挂 requireAuth+requireAdmin），路由内不挂鉴权。
 */

import { Router } from 'express';
import { agentInstanceIdParamsSchema, agentInstanceResponseSchema } from '@dommaker/studio-contract';
import { AgentInstanceService } from './agent-instance.service.js';
import { defineRoute } from '../../core/http.js';

const adminRoutes = Router();
const service = new AgentInstanceService();

/** POST /:id/terminate — 强制停止实例：unclaim 当前 WorkUnit 并置 blocked 转人工（2026-07 §4 语义修正，活 loop 不会重新认领）+ 实例置 terminated */
adminRoutes.post('/:id/terminate', defineRoute(
  { params: agentInstanceIdParamsSchema, response: agentInstanceResponseSchema },
  { errors: [{ match: 'not found', status: 404, code: 'NOT_FOUND' }] },
  async (_req, _res, { params }) => {
    return service.terminate(params.id);
  },
));

export { adminRoutes as agentInstanceAdminRoutes };
