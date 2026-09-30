/**
 * agents 域契约（批次 8/8）——legacy /api/v1/agents + §10.5 token-usage 双挂面。
 * 正本以 apps/api/src/modules/agents/routes.ts（LEGACY surface，web 消费方已清 #347，
 * 计划迁移到 agent-profiles / workunit API，迁移前不扩展）与
 * token-usage.service.ts（AgentTokenUsage）实测 wire 为准。
 *
 * 端点（route-registry 同挂 /api/v1/agents，assertRouteOrder 保证
 * tokenUsageRoutes 先于 legacy agentRoutes 注册——token-usage 只处理
 * GET /:id/token-usage，其余路径自然落到 legacy 路由）：
 *   GET    /agents/:id/token-usage  profile 级 token 聚合（只读；空数据返回全零不抛错）
 *   GET    /agents                  legacy 列表（category/tags 过滤 + 分页）
 *   POST   /agents                  legacy 注册（requireAuth + requireNotGuest）
 *   GET    /agents/:agentId         legacy 详情（?version=）
 *   PUT    /agents/:agentId         legacy 更新（requireAuth + requireNotGuest；version 必填）
 *   DELETE /agents/:agentId         legacy 删除（requireRole('Admin')；version 必填）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - GET /agents 原 `{ data, pagination }` ≡ paginated 分页壳，形状不变
 * - POST/GET/:agentId/PUT 裸 AgentMetadata → `{ data: T }`（无消费方——
 *   前端 grep 实证 apps/web 无 /api/v1/agents 调用）
 * - GET /:id/token-usage 裸聚合 → `{ data: usage }`（无前端消费方）
 * - 500 code 'INTERNAL_ERROR' 归一为 INTERNAL；message 由固定串
 *   （'Failed to list agents' 等）变为实际错误消息
 * - PUT/DELETE 的 version 必填保留 400 VERSION_REQUIRED（HttpError，不收 zod）
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

// ── legacy AgentMetadata（studio-agent 引 Node 依赖不可 import，wire 重声明）──

/** AgentMetadata.category 词表（studio-agent/src/types.ts AgentCategory） */
export const legacyAgentCategorySchema = z.enum(['llm', 'tool', 'processor', 'connector', 'custom']);

/**
 * JSONSchema 字段（inputSchema/outputSchema/configSchema）：声明为开放对象——
 * 响应面不做深校验，registry 落库形状由 studio-agent 自持。
 */
const jsonSchemaWireSchema = z.record(z.unknown());

/**
 * legacy AgentMetadata wire（studio-agent/src/types.ts 重声明）。
 * passthrough 放行扩展键（KV 缓存行可能带 registry 后续版本新增字段）。
 * 无消费方，z.infer 不手写。
 */
export const legacyAgentMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  category: legacyAgentCategorySchema,
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  inputSchema: jsonSchemaWireSchema,
  outputSchema: jsonSchemaWireSchema,
  configSchema: jsonSchemaWireSchema,
  endpoint: z.string().optional(),
  timeout: z.number().optional(),
  retryPolicy: z.object({
    maxRetries: z.number(),
    backoff: z.enum(['fixed', 'exponential']),
    initialDelay: z.number(),
    maxDelay: z.number(),
  }).optional(),
  rateLimit: z.object({
    requests: z.number(),
    windowMs: z.number(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();
export type LegacyAgentMetadata = z.infer<typeof legacyAgentMetadataSchema>;

// ── §10.5 token 聚合 ──

export const tokenUsageWindowSchema = z.object({
  injectedTokens: z.number(),
  executionTokens: z.number(),
  totalTokens: z.number(),
});
export type TokenUsageWindow = z.infer<typeof tokenUsageWindowSchema>;

/** profile 级 token 滚动视图（无前端消费方，z.infer 不手写） */
export const agentTokenUsageSchema = z.object({
  profileId: z.string(),
  totals: tokenUsageWindowSchema,
  /** 本地自然日（与 now 同一天） */
  today: tokenUsageWindowSchema,
  /** 滚动 7 天（now-7d ~ now） */
  rolling7d: tokenUsageWindowSchema,
  /** 有 token 事件归因到本 profile 的去重 WU 数 */
  workUnitCount: z.number(),
  trees: z.object({
    participated: z.number(),
    avgTreeDepth: z.number(),
  }),
  generatedAt: z.string(),
});
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;

// ── 请求 ──

/** GET /agents：page/limit 原样为字符串（handler parseInt）；tags 逗号分隔串 */
export const legacyAgentListQuerySchema = z.object({
  category: z.string().optional(),
  tags: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type LegacyAgentListQuery = z.infer<typeof legacyAgentListQuerySchema>;

/**
 * POST /agents 注册体：字段全集归 AgentRegistry.register 自持（原样透传 req.body），
 * passthrough 放行；已知键声明仅作文档。
 */
export const legacyAgentRegisterBodySchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  category: legacyAgentCategorySchema.optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  inputSchema: jsonSchemaWireSchema.optional(),
  outputSchema: jsonSchemaWireSchema.optional(),
  configSchema: jsonSchemaWireSchema.optional(),
  endpoint: z.string().optional(),
  timeout: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
export type LegacyAgentRegisterBody = z.infer<typeof legacyAgentRegisterBodySchema>;

/** PUT /agents/:agentId 更新体：同注册体全透传（registry.update 自持字段集） */
export const legacyAgentUpdateBodySchema = z.object({}).passthrough();
export type LegacyAgentUpdateBody = z.infer<typeof legacyAgentUpdateBodySchema>;

export const legacyAgentIdParamsSchema = z.object({ agentId: z.string().min(1) });

/** GET/PUT/DELETE 的 ?version=（GET 可选；PUT/DELETE 必填——handler HttpError 400 VERSION_REQUIRED 保留原 code） */
export const legacyAgentVersionQuerySchema = z.object({
  version: z.string().optional(),
});
export type LegacyAgentVersionQuery = z.infer<typeof legacyAgentVersionQuerySchema>;

export const agentTokenUsageParamsSchema = z.object({ id: z.string().min(1) });

// ── 响应 ──

/** GET /agents → 分页壳 `{ data: [...], pagination }`（形状不变） */
export const legacyAgentListResponseSchema = paginatedBodySchema(legacyAgentMetadataSchema);
export const legacyAgentResponseSchema = dataBodySchema(legacyAgentMetadataSchema);
export const agentTokenUsageResponseSchema = dataBodySchema(agentTokenUsageSchema);
