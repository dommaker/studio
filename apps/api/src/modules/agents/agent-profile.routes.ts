/**
 * AgentProfile API 路由 (AS-025 Phase 2)
 *
 * 契约驱动迁移（2026-10 批次 8/8）：全部端点走 core/http.ts defineRoute——
 * name 必填收进 zod（原手写 400 INVALID_INPUT → 400 BAD_REQUEST）；409 改名冲突
 * 走错误映射表（message = service 原始消息，含 'Unique constraint:' 前缀）；
 * 裸实体响应统一 `{ data }` 壳；500 code 'INTERNAL_ERROR' 归一 INTERNAL。
 *
 * Endpoints:
 *   GET    /api/v1/agent-profiles          — list
 *   POST   /api/v1/agent-profiles          — create
 *   GET    /api/v1/agent-profiles/presets  — 角色 preset 清单（#633，须在 /:id 前注册）
 *   GET    /api/v1/agent-profiles/:id      — get by id
 *   PATCH  /api/v1/agent-profiles/:id      — update
 *   DELETE /api/v1/agent-profiles/:id      — delete
 */

import { Router } from 'express';

import {
  agentProfileListQuerySchema,
  createAgentProfileBodySchema,
  updateAgentProfileBodySchema,
  agentProfileIdParamsSchema,
} from '@dommaker/studio-contract';
import { AgentProfileService, listRolePresets, type CreateAgentProfileInput, type UpdateAgentProfileInput } from './agent-profile.service.js';
import { parsePagination } from '../../utils/pagination.js';
import { defineRoute, HttpError, paginated } from '../../core/http.js';
import { getStore } from '../../core/store.js';


// P2-e 鉴权声明式统一：open（GET 读）/ write（registry 挂 authNotGuest）拆 router，路由内不再挂鉴权。
const openRoutes = Router();
const writeRoutes = Router();
const service = new AgentProfileService(getStore());

/** GET / — list AgentProfiles */
openRoutes.get('/', defineRoute({ query: agentProfileListQuerySchema }, async (req, _res, { query }) => {
  const { page, limit } = parsePagination(req);

  const result = await service.list({
    status: query.status,
    channelId: query.channelId,
    page,
    limit,
    // AC-1.4: includeSystem=true 时包含 studio 角色（前端 setup 用）
    includeSystem: query.includeSystem === 'true',
  });

  return paginated(result.data, {
    page,
    limit,
    total: result.total,
    totalPages: Math.ceil(result.total / limit),
  });
}));

/** POST / — create AgentProfile */
writeRoutes.post('/', defineRoute(
  { body: createAgentProfileBodySchema },
  {
    status: 201,
    errors: [{ match: 'Unique constraint', status: 409, code: 'DUPLICATE' }],
  },
  async (_req, _res, { body }) => {
    // z.infer 全字段退化可选（仓 strict:false），路由边界收回 service 必填入参
    return service.create(body as CreateAgentProfileInput);
  },
));

/** GET /presets — 角色 preset 清单（#633「从模板开始」数据源；只回 name + description，死字段不浮出）。
 *  须注册在 /:id 之前，否则 'presets' 被当 id 匹配。 */
openRoutes.get('/presets', defineRoute({}, async () => listRolePresets()));

/** GET /:id — get AgentProfile by id */
openRoutes.get('/:id', defineRoute({ params: agentProfileIdParamsSchema }, async (_req, _res, { params }) => {
  const profile = await service.getById(params.id);
  if (!profile) {
    throw new HttpError(404, 'NOT_FOUND', `AgentProfile ${params.id} not found`);
  }
  return profile;
}));

/** PATCH /:id — update AgentProfile */
writeRoutes.patch('/:id', defineRoute(
  { params: agentProfileIdParamsSchema, body: updateAgentProfileBodySchema },
  {
    errors: [
      // #298: 改名冲突与 create 同口径 -> 409 DUPLICATE
      { match: 'Unique constraint', status: 409, code: 'DUPLICATE' },
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'Record to update not found', status: 404, code: 'NOT_FOUND' },
    ],
  },
  async (_req, _res, { params, body }) => {
    return service.update(params.id, body as UpdateAgentProfileInput);
  },
));

/** DELETE /:id — delete AgentProfile */
writeRoutes.delete('/:id', defineRoute(
  { params: agentProfileIdParamsSchema },
  {
    status: 204,
    errors: [
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'Record to delete does not exist', status: 404, code: 'NOT_FOUND' },
    ],
  },
  async (_req, _res, { params }) => {
    await service.delete(params.id);
  },
));

export { openRoutes as agentProfileOpenRoutes, writeRoutes as agentProfileWriteRoutes };
