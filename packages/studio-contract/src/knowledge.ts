/**
 * knowledge 域契约——正本字段以 apps/api/src/modules/knowledge/ 实测 wire 为准：
 * knowledge-service.ts（KnowledgeService list/get/stats/health/flywheel/audit 等）、
 * knowledge-metrics.ts（FlywheelMetrics/HealthReport/AuditReport/AccuracyReport）、
 * resolution.service.ts（Resolution 投影/density/cross-session，Resolution wire 与
 * studio-shared types/resolution.ts 内存型有意不同构，schema 即正本，见下方注记）、
 * engine/unified-query.ts（ListEntriesResult）、knowledge-sync.service.ts、
 * knowledge-design-doc.ts（upsertKnowledge 结果）、knowledge-curator.service.ts
 * （runDailyMaintenance 聚合）与各 routes 实测响应。knowledgeEntrySchema 与
 * harness KnowledgeEntry import type 同源（#685；executionResults 单向锚定，
 * 条目级锚定受 sourceReferences 所限不可表达，见下方注记）。
 *
 * 三套路由（route-registry.ts）：
 * - /api/v1/knowledge（files/entries/search/maintenance 子路由，auth）
 * - /api/v1/knowledge-service（KnowledgeService HTTP API，auth）
 * - /api/knowledge（internal，本机回环限定，无 auth）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部 JSON 端点 `{ data: T }`（原平铺/裸对象/{ success } 全收进壳）
 * - GET /export 附件下载（md/json）handler 自写 res 不进壳（specs 先例）；
 *   GET /knowledge-service/events 301 跳转提示 handler 自写 res 不进壳
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

/** POST /knowledge/ask 响应 data */
export const knowledgeAskResultSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
  })),
});
export type KnowledgeAskResult = z.infer<typeof knowledgeAskResultSchema>;

/** GET /knowledge/gaps/:type 响应 data */
export const knowledgeGapsResultSchema = z.object({
  type: z.string(),
  data: z.array(z.record(z.unknown())),
  total: z.number(),
});
export type KnowledgeGapsResult = z.infer<typeof knowledgeGapsResultSchema>;

/** GET /knowledge/gaps 响应 data（五类统计概览，各类形状不一） */
export const knowledgeGapStatsSchema = z.record(z.unknown());
export type KnowledgeGapStats = z.infer<typeof knowledgeGapStatsSchema>;

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

/** GET /knowledge/resolution/density 响应 data */
export const resolutionDensityScoreSchema = z.object({
  score: z.number(),
  total: z.number(),
  verified: z.number(),
  proven: z.number(),
  errorClasses: z.number(),
  layers: z.number(),
});
export type ResolutionDensityScore = z.infer<typeof resolutionDensityScoreSchema>;

/** GET /knowledge/resolution/cross-session 响应 data */
export const crossSessionStatsSchema = z.object({
  linkedToGoals: z.number(),
  unlinked: z.number(),
  topErrorClasses: z.array(z.object({
    errorClass: z.string(),
    count: z.number(),
    avgVerifyCount: z.number(),
  })),
});
export type CrossSessionStats = z.infer<typeof crossSessionStatsSchema>;

/** GET /knowledge/requirements 响应 data（files.routes 需求文档扫描） */
export const requirementDocItemSchema = z.object({
  path: z.string(),
  name: z.string(),
  project: z.string().optional(),
  updatedAt: z.string().optional(),
  isRequirement: z.boolean().optional(),
});
export type RequirementDocItem = z.infer<typeof requirementDocItemSchema>;

export const requirementDocListResultSchema = z.object({
  docs: z.array(requirementDocItemSchema),
  total: z.number(),
});
export type RequirementDocListResult = z.infer<typeof requirementDocListResultSchema>;

/** POST /knowledge/read-file 响应 data */
export const readKnowledgeFileResultSchema = z.object({
  content: z.string(),
  path: z.string(),
  size: z.number(),
  ext: z.string(),
});
export type ReadKnowledgeFileResult = z.infer<typeof readKnowledgeFileResultSchema>;

/** GET /knowledge/file 响应 data */
export const knowledgeFileResultSchema = z.object({
  content: z.string(),
  path: z.string(),
});
export type KnowledgeFileResult = z.infer<typeof knowledgeFileResultSchema>;

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

// ── KnowledgeService 派生读（/knowledge-service 子路由）──

/** GET /knowledge-service/stats 响应 data（tags[0] 分桶计数 + total） */
export const knowledgeServiceStatsSchema = z.record(z.number());
export type KnowledgeServiceStats = z.infer<typeof knowledgeServiceStatsSchema>;

/** GET /knowledge-service/search 的 results 元素（knowledgeService.search） */
export const knowledgeServiceSearchHitSchema = z.object({
  entry: knowledgeEntrySchema,
  score: z.number(),
  highlights: z.array(z.string()),
});
export type KnowledgeServiceSearchHit = z.infer<typeof knowledgeServiceSearchHitSchema>;

/** GET /knowledge-service/search 响应 data */
export const knowledgeServiceSearchResultSchema = z.object({
  results: z.array(knowledgeServiceSearchHitSchema),
  total: z.number(),
});
export type KnowledgeServiceSearchResult = z.infer<typeof knowledgeServiceSearchResultSchema>;

/** GET /knowledge-service/entries 响应 data */
export const knowledgeEntryListResultSchema = z.object({
  entries: z.array(knowledgeEntryItemSchema),
  total: z.number(),
});
export type KnowledgeEntryListResult = z.infer<typeof knowledgeEntryListResultSchema>;

/** GET /knowledge-service/entries/stats 响应 data（stats 分桶 + healthScore ← HealthReport.score） */
export const knowledgeEntryStatsResultSchema = z.record(z.unknown());
export type KnowledgeEntryStatsResult = z.infer<typeof knowledgeEntryStatsResultSchema>;

/** GET /knowledge-service/health 响应 data */
export const knowledgeHealthReportSchema = z.object({
  score: z.number(),
  totalEntries: z.number(),
  staleEntries: z.number(),
  orphanEntries: z.number(),
  duplicateEntries: z.number(),
  timestamp: z.string(),
});
export type KnowledgeHealthReport = z.infer<typeof knowledgeHealthReportSchema>;

/** GET /knowledge-service/flywheel 响应 data */
export const knowledgeFlywheelMetricsSchema = z.object({
  quality: z.number(),
  hitRate: z.number(),
  improvement: z.number(),
  freshness: z.number(),
  timestamp: z.string(),
  /** 'events' = 实算；'insufficient-data' = 窗口内无 outcome 事件，0 占位而非编造 */
  source: z.enum(['events', 'insufficient-data']).optional(),
});
export type KnowledgeFlywheelMetrics = z.infer<typeof knowledgeFlywheelMetricsSchema>;

/** GET /knowledge-service/audit 响应 data */
export const knowledgeAuditReportSchema = z.object({
  findings: z.array(z.object({
    type: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    description: z.string(),
    entryId: z.string().optional(),
  })),
  trend: z.string(),
  timestamp: z.string(),
  eventCounts: z.object({
    windowDays: z.number(),
    consumption: z.number(),
    outcomeSuccess: z.number(),
    outcomeFailure: z.number(),
    extraction: z.number(),
    source: z.enum(['events', 'insufficient-data']),
  }),
  entries: z.object({
    total: z.number(),
    byMaturity: z.record(z.number()),
    source: z.literal('store'),
  }),
  topReferenced: z.array(z.object({
    id: z.string(),
    title: z.string(),
    references: z.number(),
  })),
  extractionActivity: z.object({
    count: z.number(),
    totalTokens: z.number(),
    lastAt: z.string().nullable(),
    source: z.enum(['events', 'insufficient-data']),
  }),
});
export type KnowledgeAuditReport = z.infer<typeof knowledgeAuditReportSchema>;

/** GET /knowledge-service/analyst-accuracy 响应 data（M1 诚实契约：无数据源 → available:false） */
export const analystAccuracyReportSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  overallAccuracy: z.number().optional(),
  byAnalyst: z.record(z.number()).optional(),
  recentPredictions: z.array(z.record(z.unknown())).optional(),
  timestamp: z.string(),
});
export type AnalystAccuracyReport = z.infer<typeof analystAccuracyReportSchema>;

/** POST /knowledge-service/inject-context 响应 data */
export const injectContextResultSchema = z.object({
  context: z.string(),
  injectedIds: z.array(z.string()),
});
export type InjectContextResult = z.infer<typeof injectContextResultSchema>;

/** POST /knowledge-service/match-resolutions 响应 data */
export const matchResolutionsResultSchema = z.object({
  matched: z.boolean(),
  resolutions: z.array(resolutionSchema),
});
export type MatchResolutionsResult = z.infer<typeof matchResolutionsResultSchema>;

/** 各写端点的 `{ success }` / `{ success, id }` 响应 data */
export const knowledgeSuccessResultSchema = z.object({ success: z.boolean() });
export type KnowledgeSuccessResult = z.infer<typeof knowledgeSuccessResultSchema>;

export const createKnowledgeEntryResultSchema = z.object({
  success: z.boolean(),
  id: z.string(),
});
export type CreateKnowledgeEntryResult = z.infer<typeof createKnowledgeEntryResultSchema>;

// ── 请求：query / params ──

/** GET /knowledge/export（format=md|json；types 逗号分隔；limit clamp 走 parsePagination） */
export const knowledgeExportQuerySchema = z.object({
  format: z.string().optional(),
  types: z.string().optional(),
  limit: z.string().optional(),
});
export type KnowledgeExportQuery = z.infer<typeof knowledgeExportQuerySchema>;

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

/** GET /knowledge/file（path 必填——原手写 400 收进 zod） */
export const knowledgeFileQuerySchema = z.object({
  path: z.string().min(1),
});
export type KnowledgeFileQuery = z.infer<typeof knowledgeFileQuerySchema>;

/** GET /knowledge-service/search（q 必填；limit clamp 走 parsePagination） */
export const knowledgeServiceSearchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.string().optional(),
});
export type KnowledgeServiceSearchQuery = z.infer<typeof knowledgeServiceSearchQuerySchema>;

/** GET /knowledge-service/entries（逗号分隔多值；limit clamp 走 parsePagination） */
export const listKnowledgeEntriesQuerySchema = z.object({
  type: z.string().optional(),
  tags: z.string().optional(),
  maturity: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});
export type ListKnowledgeEntriesQuery = z.infer<typeof listKnowledgeEntriesQuerySchema>;

export const knowledgeEntryIdParamsSchema = z.object({ id: z.string().min(1) });
export type KnowledgeEntryIdParams = z.infer<typeof knowledgeEntryIdParamsSchema>;

// ── 请求：body ──

/** POST /knowledge/ask（question 必填——原手写 400 收进 zod） */
export const knowledgeAskBodySchema = z.object({
  question: z.string().min(1),
  types: z.array(z.string()).optional(),
  limit: z.number().optional(),
});
export type KnowledgeAskBody = z.infer<typeof knowledgeAskBodySchema>;

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

/** POST /knowledge/read-file（filePath 必填——原手写 400 收进 zod） */
export const readKnowledgeFileBodySchema = z.object({
  filePath: z.string().min(1),
});
export type ReadKnowledgeFileBody = z.infer<typeof readKnowledgeFileBodySchema>;

/** POST /api/knowledge/upsert（scope/title/content 必填——原手写 400 收进 zod） */
export const upsertKnowledgeBodySchema = z.object({
  scope: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional(),
  source: z.string().optional(),
});
export type UpsertKnowledgeBody = z.infer<typeof upsertKnowledgeBodySchema>;

/** POST /knowledge-service/entries（完整条目，四字段必填；passthrough 放行条目其余字段） */
export const createKnowledgeEntryBodySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
}).passthrough();
export type CreateKnowledgeEntryBody = z.infer<typeof createKnowledgeEntryBodySchema>;

/** PUT /knowledge-service/entries/:id（部分条目字段，任意键） */
export const updateKnowledgeEntryBodySchema = z.record(z.unknown());
export type UpdateKnowledgeEntryBody = z.infer<typeof updateKnowledgeEntryBodySchema>;

/** POST /knowledge-service/pattern（origin 仅 human/agent 白名单生效，其余落 system 缺省） */
export const recordPatternBodySchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  origin: z.string().optional(),
});
export type RecordPatternBody = z.infer<typeof recordPatternBodySchema>;

/** POST /knowledge-service/incident */
export const recordIncidentBodySchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  severity: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
export type RecordIncidentBody = z.infer<typeof recordIncidentBodySchema>;

/** POST /knowledge-service/trend */
export const recordTrendBodySchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metric: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
export type RecordTrendBody = z.infer<typeof recordTrendBodySchema>;

/** POST /knowledge-service/inject-context */
export const injectContextBodySchema = z.object({
  agentType: z.string().min(1),
  tags: z.array(z.string()).optional(),
  maxTokens: z.number().optional(),
  includeRules: z.boolean().optional(),
});
export type InjectContextBody = z.infer<typeof injectContextBodySchema>;

/** POST /knowledge-service/match-resolutions */
export const matchResolutionsBodySchema = z.object({
  problem: z.string().min(1),
});
export type MatchResolutionsBody = z.infer<typeof matchResolutionsBodySchema>;

/** POST /knowledge-service/record-outcome（success 原按 `=== undefined` 判缺 → zod boolean 必填） */
export const recordOutcomeBodySchema = z.object({
  executionId: z.string().min(1),
  agentType: z.string().min(1),
  success: z.boolean(),
  consumedKnowledge: z.array(z.string()).optional(),
  details: z.string().optional(),
  timestamp: z.string().optional(),
  mode: z.string().optional(),
});
export type RecordOutcomeBody = z.infer<typeof recordOutcomeBodySchema>;

/** POST /knowledge-service/{promote,demote,decay} */
export const knowledgeLifecycleBodySchema = z.object({
  entryId: z.string().min(1),
});
export type KnowledgeLifecycleBody = z.infer<typeof knowledgeLifecycleBodySchema>;

/** POST /knowledge-service/merge */
export const mergeKnowledgeBodySchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
});
export type MergeKnowledgeBody = z.infer<typeof mergeKnowledgeBodySchema>;

// ── 响应（统一 `{ data }` 壳；GET /export 附件与 /events 301 不进壳）──

export const requirementDocListResponseSchema = dataBodySchema(requirementDocListResultSchema);
export const readKnowledgeFileResponseSchema = dataBodySchema(readKnowledgeFileResultSchema);
export const knowledgeFileResponseSchema = dataBodySchema(knowledgeFileResultSchema);
export const knowledgeAskResponseSchema = dataBodySchema(knowledgeAskResultSchema);
export const knowledgeGapsResponseSchema = dataBodySchema(knowledgeGapsResultSchema);
export const knowledgeGapStatsResponseSchema = dataBodySchema(knowledgeGapStatsSchema);
export const unifiedKnowledgeListResponseSchema = dataBodySchema(unifiedKnowledgeListResultSchema);
export const createUnifiedEntryResponseSchema = dataBodySchema(createUnifiedEntryResultSchema);
export const resolutionListResponseSchema = dataBodySchema(resolutionListResultSchema);
export const knowledgeSearchResponseSchema = dataBodySchema(knowledgeSearchListResultSchema);
export const resolutionDensityResponseSchema = dataBodySchema(resolutionDensityScoreSchema);
export const crossSessionStatsResponseSchema = dataBodySchema(crossSessionStatsSchema);
export const knowledgeSyncStatusResponseSchema = dataBodySchema(knowledgeSyncStatusResultSchema);
export const upsertKnowledgeResponseSchema = dataBodySchema(upsertKnowledgeResultSchema);
export const knowledgeMaintenanceResponseSchema = dataBodySchema(knowledgeMaintenanceResultSchema);
export const knowledgeServiceStatsResponseSchema = dataBodySchema(knowledgeServiceStatsSchema);
export const knowledgeServiceSearchResponseSchema = dataBodySchema(knowledgeServiceSearchResultSchema);
export const knowledgeEntryListResponseSchema = dataBodySchema(knowledgeEntryListResultSchema);
export const knowledgeEntryResponseSchema = dataBodySchema(knowledgeEntrySchema);
export const createKnowledgeEntryResponseSchema = dataBodySchema(createKnowledgeEntryResultSchema);
export const knowledgeEntryStatsResponseSchema = dataBodySchema(knowledgeEntryStatsResultSchema);
export const knowledgeHealthResponseSchema = dataBodySchema(knowledgeHealthReportSchema);
export const knowledgeFlywheelResponseSchema = dataBodySchema(knowledgeFlywheelMetricsSchema);
export const knowledgeAuditResponseSchema = dataBodySchema(knowledgeAuditReportSchema);
export const analystAccuracyResponseSchema = dataBodySchema(analystAccuracyReportSchema);
export const injectContextResponseSchema = dataBodySchema(injectContextResultSchema);
export const matchResolutionsResponseSchema = dataBodySchema(matchResolutionsResultSchema);
export const knowledgeSuccessResponseSchema = dataBodySchema(knowledgeSuccessResultSchema);
