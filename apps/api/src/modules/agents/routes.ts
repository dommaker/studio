// Agent API 路由
// ⚠️ LEGACY surface — web 端消费方已清（#347：agentStore/agentApi 删除，web 走 agent-profiles）。
// 计划迁移到 agent-profiles / workunit API（见 docs/vision-2026.md），迁移前请勿在此扩展新功能。
//
// 契约驱动迁移（2026-10 批次 8/8）：全部端点走 core/http.ts defineRoute——
// 裸 AgentMetadata 响应统一 `{ data }` 壳（无消费方）；409 AGENT_EXISTS 与
// 400 VERSION_REQUIRED 保留原 code；500 code 'INTERNAL_ERROR' 归一 INTERNAL，
// message 由固定串（'Failed to list agents' 等）变为实际错误消息。
import { Router } from 'express';
import { AgentRegistry } from '@dommaker/studio-agent';
import {
  legacyAgentListQuerySchema,
  legacyAgentRegisterBodySchema,
  legacyAgentUpdateBodySchema,
  legacyAgentIdParamsSchema,
  legacyAgentVersionQuerySchema,
} from '@dommaker/studio-contract';
import { memoryStore } from '@dommaker/studio-shared';
import { defineRoute, HttpError, paginated } from '../../core/http.js';

// P2-e 鉴权声明式统一：open（GET 读）/ write（registry 挂 authNotGuest）/ admin（DELETE，registry 挂
// requireAuth+requireAdmin）三档拆 router，路由内不再挂鉴权。
const openRoutes = Router();
const writeRoutes = Router();
const adminRoutes = Router();

// 延迟初始化：首次请求时创建 AgentRegistry 实例
let registry: InstanceType<typeof AgentRegistry>;

async function initRegistry() {
  if (!registry) {
    // #324：event-store 已删除，KV 缓存走 studio-shared 的 memoryStore（同接口）
    registry = new AgentRegistry(memoryStore);
  }
  return registry;
}

// 获取 Agent 列表
openRoutes.get('/', defineRoute({ query: legacyAgentListQuerySchema }, async (_req, _res, { query }) => {
  const reg = await initRegistry();
  const page = parseInt(query.page ?? '1');
  const limit = parseInt(query.limit ?? '20');

  const result = await reg.list({
    category: query.category,
    tags: query.tags ? query.tags.split(',') : undefined,
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

// 注册新 Agent
writeRoutes.post('/', defineRoute(
  { body: legacyAgentRegisterBodySchema },
  {
    status: 201,
    errors: [{ match: 'already exists', status: 409, code: 'AGENT_EXISTS' }],
  },
  async (_req, _res, { body }) => {
    const reg = await initRegistry();
    // body passthrough 全透传（字段集归 registry 自持）；z.infer 退化可选，边界收回
    return reg.register(body as unknown as Parameters<AgentRegistry['register']>[0]);
  },
));

// 获取 Agent 详情
openRoutes.get('/:agentId', defineRoute(
  { params: legacyAgentIdParamsSchema, query: legacyAgentVersionQuerySchema },
  async (_req, _res, { params, query }) => {
    const reg = await initRegistry();
    const agent = await reg.get(params.agentId, query.version);

    if (!agent) {
      throw new HttpError(404, 'NOT_FOUND', `Agent ${params.agentId} not found`);
    }

    return agent;
  },
));

// 更新 Agent
writeRoutes.put('/:agentId', defineRoute(
  { params: legacyAgentIdParamsSchema, query: legacyAgentVersionQuerySchema, body: legacyAgentUpdateBodySchema },
  async (_req, _res, { params, query, body }) => {
    const reg = await initRegistry();

    if (!query.version) {
      throw new HttpError(400, 'VERSION_REQUIRED', 'Version is required');
    }

    return reg.update(params.agentId, query.version, body as unknown as Parameters<AgentRegistry['update']>[2]);
  },
));

// 删除 Agent
// 🆕 SEC-002: Admin only
adminRoutes.delete('/:agentId', defineRoute(
  { params: legacyAgentIdParamsSchema, query: legacyAgentVersionQuerySchema },
  { status: 204 },
  async (_req, _res, { params, query }) => {
    const reg = await initRegistry();

    if (!query.version) {
      throw new HttpError(400, 'VERSION_REQUIRED', 'Version is required');
    }

    await reg.delete(params.agentId, query.version);
  },
));

export { openRoutes as agentOpenRoutes, writeRoutes as agentWriteRoutes, adminRoutes as agentAdminRoutes };
