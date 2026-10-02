/**
 * RuntimeInstance API 路由 (AS-026 AC-1)
 *
 * 契约驱动迁移（2026-10 批次 8/8）：全部端点走 core/http.ts defineRoute——
 * roleId 必填收进 zod（原手写 400 INVALID_INPUT → 400 BAD_REQUEST）；
 * INVALID_REFERENCE/Invalid status/not found 走错误映射表；裸实体响应统一
 * `{ data }` 壳；500 code 'INTERNAL_ERROR' 归一 INTERNAL。
 *
 * Endpoints:
 *   GET    /api/v1/agent-instances          — list
 *   POST   /api/v1/agent-instances          — create
 *   GET    /api/v1/agent-instances/:id      — get by id
 *   PATCH  /api/v1/agent-instances/:id      — update
 *   POST   /api/v1/agent-instances/:id/terminate — 强制停止：unclaim + WorkUnit 置 blocked 转人工 + 实例 terminated
 */

import { Router } from 'express';
import {
  agentInstanceListQuerySchema,
  createAgentInstanceBodySchema,
  updateAgentInstanceBodySchema,
  agentInstanceIdParamsSchema,
} from '@dommaker/studio-contract';
import { AgentInstanceService, type CreateInstanceInput, type UpdateInstanceInput } from './agent-instance.service.js';
import { parsePagination } from '../../utils/pagination.js';
import { defineRoute, HttpError, paginated } from '../../core/http.js';

// P2-e 鉴权声明式统一：open（GET 读）/ write（registry 挂 authNotGuest）/ admin（terminate，registry 挂
// requireAuth+requireAdmin）三档拆 router，路由内不再挂鉴权。
const openRoutes = Router();
const writeRoutes = Router();
const adminRoutes = Router();
const service = new AgentInstanceService();

/** GET / — list RuntimeInstances */
openRoutes.get('/', defineRoute({ query: agentInstanceListQuerySchema }, async (req, _res, { query }) => {
  const { page, limit } = parsePagination(req);

  const result = await service.list({
    status: query.status,
    page,
    limit,
  });

  return paginated(result.data, {
    page,
    limit,
    total: result.total,
    totalPages: Math.ceil(result.total / limit),
  });
}));

/** POST / — create RuntimeInstance */
writeRoutes.post('/', defineRoute(
  { body: createAgentInstanceBodySchema },
  {
    status: 201,
    errors: [
      { match: 'Foreign key constraint', status: 400, code: 'INVALID_REFERENCE' },
      { match: 'P2003', status: 400, code: 'INVALID_REFERENCE' },
    ],
  },
  async (_req, _res, { body }) => {
    // z.infer 全字段退化可选（仓 strict:false），路由边界收回 service 必填入参
    return service.create(body as CreateInstanceInput);
  },
));

/** GET /:id — get RuntimeInstance by id */
openRoutes.get('/:id', defineRoute({ params: agentInstanceIdParamsSchema }, async (_req, _res, { params }) => {
  const instance = await service.getById(params.id);
  if (!instance) {
    throw new HttpError(404, 'NOT_FOUND', `RuntimeInstance ${params.id} not found`);
  }
  return instance;
}));

/** PATCH /:id — update RuntimeInstance */
writeRoutes.patch('/:id', defineRoute(
  { params: agentInstanceIdParamsSchema, body: updateAgentInstanceBodySchema },
  {
    errors: [
      { match: 'Invalid status', status: 400, code: 'INVALID_INPUT' },
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
    ],
  },
  async (_req, _res, { params, body }) => {
    return service.update(params.id, body as UpdateInstanceInput);
  },
));

/** POST /:id/terminate — 强制停止实例：unclaim 当前 WorkUnit 并置 blocked 转人工（2026-07 §4 语义修正，活 loop 不会重新认领）+ 实例置 terminated */
adminRoutes.post('/:id/terminate', defineRoute(
  { params: agentInstanceIdParamsSchema },
  { errors: [{ match: 'not found', status: 404, code: 'NOT_FOUND' }] },
  async (_req, _res, { params }) => {
    return service.terminate(params.id);
  },
));

export { openRoutes as agentInstanceOpenRoutes, writeRoutes as agentInstanceWriteRoutes, adminRoutes as agentInstanceAdminRoutes };
