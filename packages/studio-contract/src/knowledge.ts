/**
 * knowledge 域契约——正本字段以 apps/api/src/modules/knowledge/ 实测 wire 为准：
 * knowledge-service.ts（KnowledgeService list/get/stats/health/flywheel/audit 等）、
 * knowledge-metrics.ts（FlywheelMetrics/HealthReport/AuditReport/AccuracyReport）、
 * resolution.service.ts（Resolution 投影，Resolution wire 与
 * studio-shared types/resolution.ts 内存型有意不同构，schema 即正本，见下方注记）、
 * engine/unified-query.ts（ListEntriesResult）、knowledge-sync.service.ts、
 * knowledge-design-doc.ts（upsertKnowledge 结果）、knowledge-curator.service.ts
 * （runDailyMaintenance 聚合）与各 routes 实测响应。knowledgeEntrySchema 与
 * harness KnowledgeEntry import type 同源（#685；executionResults 单向锚定，
 * 条目级锚定受 sourceReferences 所限不可表达，见下方注记）。
 *
 * 三套路由（route-registry.ts）：
 * - /api/v1/knowledge（entries/search/maintenance 子路由，auth；P4.2 起
 *   files 子路由整体已删）
 * - /api/v1/knowledge-service（KnowledgeService HTTP API，auth）
 * - /api/knowledge（internal，本机回环限定，无 auth）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部 JSON 端点 `{ data: T }`（原平铺/裸对象/{ success } 全收进壳）
 * - /api/v1/knowledge-service 自 P4.1（2026-10-17）只剩审核闭环 3 端点
 *   （GET /entries、POST /promote、POST /demote），原 20 条孤儿端点及
 *   配套 schema 已删（见 apps/api/src/modules/knowledge/CONTEXT.md）
 * - /api/v1/knowledge 自 P4.2（2026-10-17）删 8 条孤儿端点——GET /export、
 *   POST /ask、GET /gaps、GET /requirements、POST /read-file、GET /file、
 *   GET /resolution/density、GET /resolution/cross-session——配套 schema
 *   已删；保留端点见各 schema 注记
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: string }` 与
 *   `{ error: { message } }` 退役；500 文案由固定串变为实际错误消息）
 */

import { z } from 'zod';
import type { ExecutionResult as HarnessExecutionResult } from '@dommaker/studio-shared/types';
import { dataBodySchema } from './envelope.js';

// ── 实体：KnowledgeEntry（import type 同源 harness + 下方编译期锚定，#685）──

/**
 * 条目来源引用（历史行形态不一——人工创建行带 source 字段）→ 宽松 record。
 * 不与 harness SourceRef 锚定：SourceRef 是 interface（无索引签名），
 * 无法对 Record<string, unknown> 做 extends 断言，schema 即正本。
 */
export const knowledgeSourceRefSchema = z.record(z.unknown());

/** harness ExecutionResult 同源（source 联合 'human'|'auto' 收窄为 string，单向锚定兜历史数据） */
export const knowledgeExecutionResultSchema = z.object({
  contributor: z.string(),
  success: z.boolean(),
  timestamp: z.string(),
  source: z.string().optional(),
});
const _assertExecutionResult: HarnessExecutionResult extends z.infer<typeof knowledgeExecutionResultSchema> ? true : never = true;

/**
 * harness KnowledgeEntry 全字段 + Studio 扩展（unified-query 投影补
 * applicableAgents/source）。import type 同源；联合类型
 * （type/maturity/layer/consumptionMode/origin）收窄为 z.string() 兜历史数据，
 * 宽声明是既有语义不收紧。条目级 extends 锚定不可表达：sourceReferences 元素是
 * 宽松 record，而 harness SourceRef 为 interface（无索引签名），extends Record
 * 不成立——不改 schema 运行时形状凑过，schema 即正本（executionResults 已单向锚定）。
 */
export const knowledgeEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  maturity: z.string(),
  layer: z.string(),
  created: z.string(),
  lastReferenced: z.string(),
  contributors: z.array(z.string()),
  projects: z.array(z.string()),
  tags: z.array(z.string()),
  applicablePhases: z.array(z.string()),
  sourceReferences: z.array(knowledgeSourceRefSchema),
  referencedBy: z.array(z.string()),
  executionResults: z.array(knowledgeExecutionResultSchema),
  consumptionMode: z.string(),
  origin: z.string(),
  decayAt: z.string().optional(),
  fullContentPath: z.string().optional(),
  skillId: z.string().optional(),
  // Studio 扩展（unified-query.listEntries 投影）
  applicableAgents: z.array(z.string()).optional(),
  source: z.string().optional(),
});
export type KnowledgeEntryWire = z.infer<typeof knowledgeEntrySchema>;

/** 统一视图条目（GET /knowledge/unified 的 entries 元素） */
export const unifiedKnowledgeEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().optional(),
  consumptionMode: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** 成熟度（draft/verified/canonical/deprecated 等；E5 徽标与 draft 审批入口依赖本字段） */
  maturity: z.string().optional(),
}).passthrough(); // 实际下发为完整 KnowledgeEntry（投影字段之外全透传）
export type UnifiedKnowledgeEntry = z.infer<typeof unifiedKnowledgeEntrySchema>;

/** 待审列表条目（GET /knowledge-service/entries?maturity=draft 投影） */
export const knowledgeEntryItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string().optional(),
  maturity: z.string().optional(),
  created: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough(); // 实际下发为完整 KnowledgeEntry
export type KnowledgeEntryItem = z.infer<typeof knowledgeEntryItemSchema>;

// ── 实体：Resolution ──

/** 解法库条目（GET /knowledge/resolutions）。wire 与 studio-shared types/resolution.ts
 * 内存型有意不同构（源全必填 vs wire 宽松读历史行全可选；源 tags: string[] vs wire
 * string[]|string 双重编码容错），schema 即正本，不与 studio-shared Resolution 同源。 */
export const resolutionSchema = z.object({
  id: z.string(),
  title: z.string(),
  pattern: z.string().optional(),
  errorClass: z.string().optional(),
  layer: z.string().optional(),
  fix: z.string().optional(),
  status: z.string().optional(),
  verifyCount: z.number().optional(),
  verifiedAt: z.string().optional(),
  sourceGoalId: z.string().optional(),
  /** tags 后端可能双重编码为 JSON 字符串（消费方容错解析） */
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Resolution = z.infer<typeof resolutionSchema>;

// ── 实体：全局搜索结果（GET /knowledge/search 的 results 元素）──

export const knowledgeSearchResultSchema = z.object({
  type: z.string(),
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;

/** 知识缺口类型（GET /knowledge/gaps/:type 的合法值，原手写 400 校验收进 zod） */
export const knowledgeGapTypeSchema = z.enum([
  'preference', 'business_rule', 'environment', 'decision_chain', 'interaction',
]);
export type KnowledgeGapType = z.infer<typeof knowledgeGapTypeSchema>;

// ── 派生读形状 ──

/** GET /knowledge/gaps/:type 响应 data */
export const knowledgeGapsResultSchema = z.object({
  type: z.string(),
  data: z.array(z.record(z.unknown())),
  total: z.number(),
});
export type KnowledgeGapsResult = z.infer<typeof knowledgeGapsResultSchema>;

/** GET /knowledge/unified 响应 data */
export const unifiedKnowledgeListResultSchema = z.object({
  entries: z.array(unifiedKnowledgeEntrySchema),
  total: z.number(),
});
export type UnifiedKnowledgeListResult = z.infer<typeof unifiedKnowledgeListResultSchema>;

/** POST /knowledge/unified 201 响应 data */
export const createUnifiedEntryResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  consumptionMode: z.string(),
});
export type CreateUnifiedEntryResult = z.infer<typeof createUnifiedEntryResultSchema>;

/** GET /knowledge/resolutions 响应 data */
export const resolutionListResultSchema = z.object({
  resolutions: z.array(resolutionSchema),
  total: z.number(),
  byStatus: z.record(z.number()),
});
export type ResolutionListResult = z.infer<typeof resolutionListResultSchema>;

/** GET /knowledge/search 响应 data */
export const knowledgeSearchListResultSchema = z.object({
  results: z.array(knowledgeSearchResultSchema),
  total: z.number(),
});
export type KnowledgeSearchListResult = z.infer<typeof knowledgeSearchListResultSchema>;

/** GET /api/knowledge/sync-status 响应 data（internal，本机回环限定） */
export const knowledgeSyncStatusResultSchema = z.object({
  trackedScopes: z.array(z.string()),
  stale: z.array(z.record(z.unknown())),
  unmonitored: z.array(z.record(z.unknown())),
  healed: z.array(z.string()),
});
export type KnowledgeSyncStatusResult = z.infer<typeof knowledgeSyncStatusResultSchema>;

/** POST /api/knowledge/upsert 响应 data */
export const upsertKnowledgeResultSchema = z.object({
  knowledgeStore: z.object({
    action: z.enum(['created', 'updated', 'refreshed', 'unchanged']),
    entryId: z.string(),
  }),
});
export type UpsertKnowledgeResult = z.infer<typeof upsertKnowledgeResultSchema>;

/** POST /knowledge/maintenance/run 响应 data（F1：去重/质量/过期/矛盾） */
export const knowledgeMaintenanceResultSchema = z.object({
  dedupMerged: z.number(),
  qualityArchived: z.number(),
  freshnessUpdated: z.number(),
  contradictionsResolved: z.number(),
});
export type KnowledgeMaintenanceResult = z.infer<typeof knowledgeMaintenanceResultSchema>;

// ── KnowledgeService 派生读（/knowledge-service 子路由，P4.1 后仅剩审核闭环 3 端点）──

/** GET /knowledge-service/entries 响应 data */
export const knowledgeEntryListResultSchema = z.object({
  entries: z.array(knowledgeEntryItemSchema),
  total: z.number(),
});
export type KnowledgeEntryListResult = z.infer<typeof knowledgeEntryListResultSchema>;

/** 写端点的 `{ success }` 响应 data（/promote /demote） */
export const knowledgeSuccessResultSchema = z.object({ success: z.boolean() });
export type KnowledgeSuccessResult = z.infer<typeof knowledgeSuccessResultSchema>;

// ── 请求：query / params ──

/** GET /knowledge/gaps/:type（limit clamp 走 parsePagination） */
export const knowledgeGapParamsSchema = z.object({ type: knowledgeGapTypeSchema });
export type KnowledgeGapParams = z.infer<typeof knowledgeGapParamsSchema>;

export const knowledgeGapQuerySchema = z.object({
  topic: z.string().optional(),
  category: z.string().optional(),
  limit: z.string().optional(),
});
export type KnowledgeGapQuery = z.infer<typeof knowledgeGapQuerySchema>;

/** GET /knowledge/unified（逗号分隔多值；limit clamp 走 parsePagination） */
export const unifiedKnowledgeQuerySchema = z.object({
  consumptionMode: z.string().optional(),
  tags: z.string().optional(),
  origin: z.string().optional(),
  maturity: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  sortBy: z.string().optional(),
});
export type UnifiedKnowledgeQuery = z.infer<typeof unifiedKnowledgeQuerySchema>;

/** GET /knowledge/resolutions */
export const listResolutionsQuerySchema = z.object({
  status: z.string().optional(),
  errorClass: z.string().optional(),
  layer: z.string().optional(),
  search: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});
export type ListResolutionsQuery = z.infer<typeof listResolutionsQuerySchema>;

/** GET /knowledge/search（q 必填——原手写 400 收进 zod） */
export const knowledgeSearchQuerySchema = z.object({
  q: z.string().min(1),
  types: z.string().optional(),
  limit: z.string().optional(),
});
export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

/** GET /knowledge-service/entries（逗号分隔多值；limit clamp 走 parsePagination） */
export const listKnowledgeEntriesQuerySchema = z.object({
  type: z.string().optional(),
  tags: z.string().optional(),
  maturity: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});
export type ListKnowledgeEntriesQuery = z.infer<typeof listKnowledgeEntriesQuerySchema>;

// ── 请求：body ──

/** POST /knowledge/unified（四字段必填——原手写 400 收进 zod） */
export const createUnifiedEntryBodySchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  consumptionMode: z.string().min(1),
  applicableAgents: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export type CreateUnifiedEntryBody = z.infer<typeof createUnifiedEntryBodySchema>;

/** POST /api/knowledge/upsert（scope/title/content 必填——原手写 400 收进 zod） */
export const upsertKnowledgeBodySchema = z.object({
  scope: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional(),
  source: z.string().optional(),
});
export type UpsertKnowledgeBody = z.infer<typeof upsertKnowledgeBodySchema>;

/** POST /knowledge-service/{promote,demote} */
export const knowledgeLifecycleBodySchema = z.object({
  entryId: z.string().min(1),
});
export type KnowledgeLifecycleBody = z.infer<typeof knowledgeLifecycleBodySchema>;

// ── 响应（统一 `{ data }` 壳）──

export const knowledgeGapsResponseSchema = dataBodySchema(knowledgeGapsResultSchema);
export const unifiedKnowledgeListResponseSchema = dataBodySchema(unifiedKnowledgeListResultSchema);
export const createUnifiedEntryResponseSchema = dataBodySchema(createUnifiedEntryResultSchema);
export const resolutionListResponseSchema = dataBodySchema(resolutionListResultSchema);
export const knowledgeSearchResponseSchema = dataBodySchema(knowledgeSearchListResultSchema);
export const knowledgeSyncStatusResponseSchema = dataBodySchema(knowledgeSyncStatusResultSchema);
export const upsertKnowledgeResponseSchema = dataBodySchema(upsertKnowledgeResultSchema);
export const knowledgeMaintenanceResponseSchema = dataBodySchema(knowledgeMaintenanceResultSchema);
export const knowledgeEntryListResponseSchema = dataBodySchema(knowledgeEntryListResultSchema);
export const knowledgeSuccessResponseSchema = dataBodySchema(knowledgeSuccessResultSchema);
