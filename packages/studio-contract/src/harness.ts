/**
 * harness 域契约（批次 6/7）——正本以 apps/api/src/modules/harness/
 * 八个子路由（traces/constraints/knowledge/sessions/agents/diagnostics/dashboard）
 * 实测 wire 为准。@dommaker/harness 的类型不可 import（contract 包禁 Node 依赖），
 * wire 形状在此重声明。
 *
 * 端点（route-registry /api/v1/harness 挂 admin）：
 *   GET  /traces | POST /traces | GET /analysis | GET /analysis/anomalies  轨迹采集/分析（T-015）
 *   GET  /constraints | /constraints/stats | /constraints/retired | /constraints/:id
 *   POST /constraints/:id/rollback | POST /constraints/propose-upgrade     约束生命周期（T-002）
 *   POST /check-constraints                                               M2 质量门（#641 证据标志剥离）
 *   POST /knowledge/query | GET|POST /knowledge | GET|DELETE /knowledge/:id | POST /knowledge/lint
 *   POST /estimate-tokens | POST /sessions | POST /sessions/:id/events
 *   GET  /sessions/:id | POST /sessions/:id/checkpoint
 *   POST /agents | POST /agents/:id/start|complete|fail | GET /agents | GET /agents/:id
 *   POST /classify | POST /failures
 *   GET  /health
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 裸对象/平铺 → `{ data: T }`（POST /traces { recorded }、GET /analysis 五键、
 *   estimate-tokens { tokens, method }、POST /knowledge { saved, id }、
 *   DELETE /knowledge/:id { deleted }、POST /sessions/:id/events { recorded }、GET /health）
 * - 原 `{ data: X }` 单键壳（constraints/:id、knowledge/:id、sessions 三端点、agents 写端点、
 *   classify、failures、stats）形状不变
 * - 原 `{ data: [...], total }` 列表壳内层 data 键改名词键进壳（避免 data.data 双包）：
 *   traces→`{ data: { traces, total } }`、analysis/anomalies→`{ data: { anomalies, total, skippedLines } }`、
 *   constraints→`{ data: { constraints, total } }`、retired→`{ data: { retired, total } }`、
 *   knowledge list→`{ data: { entries, total } }`、knowledge/lint→`{ data: { issues, total } }`、
 *   agents list→`{ data: { agents, total } }`（均无消费方；total 保留）
 * - constraints/stats `{ data: { total, byKind, bySeverity } }` → 内层 data 剥掉直进壳（形状不变）
 * - propose-upgrade `{ success, data }` success 标志退役 → `{ data: { proposalId, posted } }`
 * - rollback `{ data, rolledBack }` 兄弟键收进 data → `{ data: { restored, rolledBack } }`
 * - check-constraints 兄弟标注键（strippedEvidenceFlags/violationPartialView）收进 data 内
 * - 错误统一 `{ error: { code, message } }`：503 Harness not available（code SERVICE_UNAVAILABLE）/
 *   404 / 400 必填（收 zod，文案变 zod 格式）；500 message 由固定串变为实际错误消息；
 *   GET /health 503 的 `status: 'unknown'` 兄弟键退役
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 宽声明（harness 实体 wire 重声明；字段全集归 harness，passthrough 放行）──

/** harness ConstraintResult 项（checkConstraints/checkConstraint 结果元素） */
export const constraintResultItemSchema = z.object({
  id: z.string(),
  satisfied: z.boolean(),
  message: z.string(),
}).passthrough();

/** harness ConstraintCheckResult（checkConstraints 结果） */
export const constraintCheckResultSchema = z.object({
  passed: z.boolean(),
  errors: z.array(constraintResultItemSchema),
  warnings: z.array(constraintResultItemSchema),
  warningCount: z.number(),
}).passthrough();

/** 生效约束条目（getEffectiveConstraints 投影） */
export const harnessConstraintSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.string(),
  trigger: z.unknown().optional(),
  rule: z.unknown().optional(),
  message: z.string().optional(),
  enforcement: z.unknown().optional(),
}).passthrough();

/** 执行轨迹条目（TraceCollector.read 返回） */
export const executionTraceSchema = z.object({
  constraintId: z.string(),
  severity: z.string(),
  result: z.string(),
  timestamp: z.number(),
}).passthrough();

/** harness 知识条目（FileKnowledgeStore） */
export const harnessKnowledgeEntrySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
}).passthrough();

/** AgentLifecycle 状态条目 */
export const harnessAgentStateSchema = z.object({
  id: z.string(),
}).passthrough();

// ── traces ──

export const tracesQuerySchema = z.object({
  constraintId: z.string().optional(),
  severity: z.string().optional(),
  result: z.string().optional(),
  hours: z.string().optional(),
  limit: z.string().optional(),
});
export type TracesQuery = z.infer<typeof tracesQuerySchema>;

/** constraintId/severity/result 必填收进 zod（原手写 400 退役）；
 * result=bypassed 保留词表内由 handler 显式 400（专属文案 'no longer supported'） */
export const traceRecordBodySchema = z.object({
  constraintId: z.string().min(1),
  severity: z.string().min(1),
  result: z.enum(['pass', 'fail', 'bypassed']),
  operation: z.string().optional(),
  projectPath: z.string().optional(),
  sessionId: z.string().optional(),
  userAction: z.string().optional(),
});
export type TraceRecordBody = z.infer<typeof traceRecordBodySchema>;

export const traceAnalysisQuerySchema = z.object({
  hours: z.string().optional(),
});
export type TraceAnalysisQuery = z.infer<typeof traceAnalysisQuerySchema>;

/** GET /traces 响应 data */
export const traceListResultSchema = z.object({
  traces: z.array(executionTraceSchema),
  total: z.number(),
});
export type TraceListResult = z.infer<typeof traceListResultSchema>;

/** GET /analysis 响应 data（summaries/anomalies 为 harness 分析形状，宽声明） */
export const traceAnalysisResultSchema = z.object({
  summaries: z.array(z.record(z.unknown())),
  anomalies: z.array(z.record(z.unknown())),
  totalSummaries: z.number(),
  totalAnomalies: z.number(),
  skippedLines: z.number(),
});
export type TraceAnalysisResult = z.infer<typeof traceAnalysisResultSchema>;

/** GET /analysis/anomalies 响应 data */
export const traceAnomaliesResultSchema = z.object({
  anomalies: z.array(z.record(z.unknown())),
  total: z.number(),
  skippedLines: z.number(),
});
export type TraceAnomaliesResult = z.infer<typeof traceAnomaliesResultSchema>;

// ── constraints ──

export const constraintIdParamsSchema = z.object({ id: z.string().min(1) });

/** 通用 /:id params（knowledge/sessions/agents 子路由共用） */
export const harnessIdParamsSchema = z.object({ id: z.string().min(1) });

/** GET /constraints 响应 data */
export const constraintListResultSchema = z.object({
  constraints: z.array(harnessConstraintSchema),
  total: z.number(),
});
export type ConstraintListResult = z.infer<typeof constraintListResultSchema>;

/** GET /constraints/stats 响应 data（0.17.0 起按 kind/severity 聚合） */
export const constraintStatsResultSchema = z.object({
  total: z.number(),
  byKind: z.record(z.number()),
  bySeverity: z.record(z.number()),
});
export type ConstraintStatsResult = z.infer<typeof constraintStatsResultSchema>;

/** GET /constraints/retired 响应 data（config.yml 墓碑唯一落点） */
export const retiredConstraintSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  source: z.literal('config'),
  retired: z.unknown(),
});
export const retiredConstraintListResultSchema = z.object({
  retired: z.array(retiredConstraintSchema),
  total: z.number(),
});
export type RetiredConstraintListResult = z.infer<typeof retiredConstraintListResultSchema>;

/** POST /constraints/propose-upgrade（ADR-0033 子项 8；constraintId 合法字符集原手写 400 收进 zod） */
export const proposeUpgradeBodySchema = z.object({
  constraintId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  repoRoot: z.string().optional(),
});
export type ProposeUpgradeBody = z.infer<typeof proposeUpgradeBodySchema>;

/** POST /constraints/propose-upgrade 响应 data */
export const proposeUpgradeResultSchema = z.object({
  proposalId: z.string(),
  posted: z.boolean(),
});
export type ProposeUpgradeResult = z.infer<typeof proposeUpgradeResultSchema>;

/** POST /constraints/:id/rollback 响应 data（restored = 回滚后重新进入生效集的定义，未进 → null） */
export const rollbackConstraintResultSchema = z.object({
  restored: harnessConstraintSchema.nullable(),
  rolledBack: z.boolean(),
});
export type RollbackConstraintResult = z.infer<typeof rollbackConstraintResultSchema>;

/** POST /check-constraints（M2 质量门；operation 必填收进 zod。
 * hasRequirement 保留声明——#641 sanitize 剥离依赖它存在（zod 剥未知键会抢先剥掉） */
export const checkConstraintsBodySchema = z.object({
  operation: z.string().min(1),
  taskDescription: z.string().optional(),
  projectPath: z.string().optional(),
  hasRequirement: z.boolean().optional(),
});
export type CheckConstraintsBody = z.infer<typeof checkConstraintsBodySchema>;

/** 违规部分视图标注（harness 1.15.0 block 模式适配，sanitize-context.ts VIOLATION_PARTIAL_VIEW） */
export const violationPartialViewSchema = z.object({
  truncated: z.boolean(),
  reason: z.string(),
});

/** POST /check-constraints 响应 data（兄弟标注键收进 data 内） */
export const checkConstraintsResultSchema = constraintCheckResultSchema.extend({
  /** #641：请求体自报被剥离的证据标志名（无剥离 → 不带该键） */
  strippedEvidenceFlags: z.array(z.string()).optional(),
  violationPartialView: violationPartialViewSchema.optional(),
});
export type CheckConstraintsResult = z.infer<typeof checkConstraintsResultSchema>;

// ── knowledge（harness 知识引擎，T-010；与 knowledge 域 /api/v1/knowledge 不同面）──

/** budget 必填收进 zod（原手写 400；positive 对齐原 `!budget` 拒 0 语义） */
export const knowledgeQueryBodySchema = z.object({
  budget: z.number().positive(),
  filter: z.record(z.unknown()).optional(),
});
export type KnowledgeQueryBody = z.infer<typeof knowledgeQueryBodySchema>;

export const harnessKnowledgeListQuerySchema = z.object({
  type: z.string().optional(),
  maturity: z.string().optional(),
  tags: z.string().optional(),
  limit: z.string().optional(),
});
export type HarnessKnowledgeListQuery = z.infer<typeof harnessKnowledgeListQuerySchema>;

/** id/title/content 必填收进 zod（原手写 400 退役） */
export const harnessKnowledgeSaveBodySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  maturity: z.string().optional(),
});
export type HarnessKnowledgeSaveBody = z.infer<typeof harnessKnowledgeSaveBodySchema>;

export const harnessKnowledgeListResultSchema = z.object({
  entries: z.array(harnessKnowledgeEntrySchema),
  total: z.number(),
});
export type HarnessKnowledgeListResult = z.infer<typeof harnessKnowledgeListResultSchema>;

export const harnessKnowledgeLintResultSchema = z.object({
  issues: z.array(z.record(z.unknown())),
  total: z.number(),
});
export type HarnessKnowledgeLintResult = z.infer<typeof harnessKnowledgeLintResultSchema>;

// ── sessions（T-011）──

/** text/object 二选一必填收进 zod refine（原手写 400 退役） */
export const estimateTokensBodySchema = z.object({
  text: z.string().optional(),
  object: z.unknown().optional(),
}).refine((v) => Boolean(v.text) || v.object !== undefined, {
  message: 'text or object is required',
});
export type EstimateTokensBody = z.infer<typeof estimateTokensBodySchema>;

export const estimateTokensResultSchema = z.object({
  tokens: z.number(),
  method: z.string(),
});
export type EstimateTokensResult = z.infer<typeof estimateTokensResultSchema>;

export const sessionCreateBodySchema = z.object({
  id: z.string().min(1),
});
export type SessionCreateBody = z.infer<typeof sessionCreateBodySchema>;

export const sessionCreateResultSchema = z.object({
  id: z.string(),
  created: z.boolean(),
});
export type SessionCreateResult = z.infer<typeof sessionCreateResultSchema>;

/** event 必填（JSON body 无 undefined，缺键即 refine 失败） */
export const sessionEventBodySchema = z.object({
  event: z.unknown().refine((v) => v !== undefined, { message: 'event is required' }),
});
export type SessionEventBody = z.infer<typeof sessionEventBodySchema>;

// ── agents（T-014）──

export const harnessAgentRegisterBodySchema = z.object({
  id: z.string().min(1),
  type: z.string().optional(),
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});
export type HarnessAgentRegisterBody = z.infer<typeof harnessAgentRegisterBodySchema>;

export const harnessAgentFailBodySchema = z.object({
  error: z.string().optional(),
});
export type HarnessAgentFailBody = z.infer<typeof harnessAgentFailBodySchema>;

export const harnessAgentCompleteBodySchema = z.object({
  metadata: z.unknown().optional(),
});
export type HarnessAgentCompleteBody = z.infer<typeof harnessAgentCompleteBodySchema>;

export const harnessAgentListResultSchema = z.object({
  agents: z.array(harnessAgentStateSchema),
  total: z.number(),
});
export type HarnessAgentListResult = z.infer<typeof harnessAgentListResultSchema>;

// ── diagnostics（T-016）──

export const classifyBodySchema = z.object({
  message: z.string().min(1),
  name: z.string().optional(),
  stack: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});
export type ClassifyBody = z.infer<typeof classifyBodySchema>;

export const failureRecordBodySchema = z.object({
  type: z.string().optional(),
  level: z.string().optional(),
  message: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});
export type FailureRecordBody = z.infer<typeof failureRecordBodySchema>;

// ── dashboard（T-017）──

export const harnessHealthResultSchema = z.object({
  status: z.string(),
  harness: z.string(),
  constraintsActive: z.boolean(),
});
export type HarnessHealthResult = z.infer<typeof harnessHealthResultSchema>;

// ── 响应（统一 `{ data }` 壳）──

export const traceListResponseSchema = dataBodySchema(traceListResultSchema);
export const traceRecordResponseSchema = dataBodySchema(z.object({ recorded: z.boolean() }));
export const traceAnalysisResponseSchema = dataBodySchema(traceAnalysisResultSchema);
export const traceAnomaliesResponseSchema = dataBodySchema(traceAnomaliesResultSchema);
export const constraintListResponseSchema = dataBodySchema(constraintListResultSchema);
export const constraintStatsResponseSchema = dataBodySchema(constraintStatsResultSchema);
export const retiredConstraintListResponseSchema = dataBodySchema(retiredConstraintListResultSchema);
export const constraintGetResponseSchema = dataBodySchema(harnessConstraintSchema);
export const proposeUpgradeResponseSchema = dataBodySchema(proposeUpgradeResultSchema);
export const rollbackConstraintResponseSchema = dataBodySchema(rollbackConstraintResultSchema);
export const checkConstraintsResponseSchema = dataBodySchema(checkConstraintsResultSchema);
export const harnessKnowledgeQueryResponseSchema = dataBodySchema(z.record(z.unknown()));
export const harnessKnowledgeListResponseSchema = dataBodySchema(harnessKnowledgeListResultSchema);
export const harnessKnowledgeGetResponseSchema = dataBodySchema(harnessKnowledgeEntrySchema);
export const harnessKnowledgeSaveResponseSchema = dataBodySchema(z.object({
  saved: z.boolean(),
  id: z.string(),
}));
export const harnessKnowledgeDeleteResponseSchema = dataBodySchema(z.object({ deleted: z.boolean() }));
export const harnessKnowledgeLintResponseSchema = dataBodySchema(harnessKnowledgeLintResultSchema);
export const estimateTokensResponseSchema = dataBodySchema(estimateTokensResultSchema);
export const sessionCreateResponseSchema = dataBodySchema(sessionCreateResultSchema);
export const sessionEventResponseSchema = dataBodySchema(z.object({ recorded: z.boolean() }));
export const sessionGetResponseSchema = dataBodySchema(z.record(z.unknown()));
export const sessionCheckpointResponseSchema = dataBodySchema(z.record(z.unknown()));
export const harnessAgentStateResponseSchema = dataBodySchema(harnessAgentStateSchema);
export const harnessAgentListResponseSchema = dataBodySchema(harnessAgentListResultSchema);
export const classifyResponseSchema = dataBodySchema(z.record(z.unknown()));
export const failureRecordResponseSchema = dataBodySchema(z.record(z.unknown()));
export const harnessHealthResponseSchema = dataBodySchema(harnessHealthResultSchema);
