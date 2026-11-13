/**
 * monitoring 域契约——schema 即 wire 正本（#685 Phase 1：手写 interface 归一为
 * z.infer 别名；运行时产出正本在 apps/api/src/modules/ops/：
 * monitoring.service.ts（AgentSummary/MonitoringStats/FlywheelStats/OverheadStats）、
 * current-wu-context.ts（AgentCurrentWorkUnit/AgentPmoSummary）、
 * metrics.types.ts（D16 OverviewMetrics 九组 + #120 EfficiencyMetrics），不可 import，alias 即归一）。
 *
 * 六个只读端点（route-registry /api/v1/monitoring 挂 admin）：
 *   GET /agents     AgentProfile + RuntimeInstance 聚合
 *   GET /stats      WorkUnit + Agent + recent 聚合
 *   GET /flywheel   M1 飞轮指标
 *   GET /overhead   M2 封装开销
 *   GET /overview   D16 九组聚合（60s 缓存；windowDays 1-90 clamp 在 handler）
 *   GET /efficiency #120 输入缓存命中率 + 段 trim 率（60s 缓存；windowDays 同上）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部 `{ data: T }`（原裸对象进壳）
 * - 错误统一 `{ error: { code, message } }`（原手写 500 已同形，code 由
 *   'INTERNAL_ERROR' 归一为 ERROR_CODES.INTERNAL，message 文案不变 = 实际错误消息）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体：/agents 聚合 ──

/** 当前 WU 快照（前端 rosterStore/useAgentRoster/ProjectPipeline 按必填消费） */
export const agentCurrentWorkUnitSchema = z.object({
  id: z.string(),
  /** metadata.title ?? scope（原样，不截断） */
  title: z.string(),
  type: z.string(),
  status: z.string(),
  claimedAt: z.string().nullable(),
});
export type AgentCurrentWorkUnit = z.infer<typeof agentCurrentWorkUnitSchema>;

/** 归属 PMO 摘要（前端 rosterStore/ProjectPipeline 按必填消费；前端别名 AgentPmoRef） */
export const agentPmoSummarySchema = z.object({
  id: z.string(),
  pmoNumber: z.string(),
  title: z.string(),
});
export type AgentPmoSummary = z.infer<typeof agentPmoSummarySchema>;

/** Agent 实例聚合条目（前端 rosterStore 合成/合并条目按必填消费） */
export const agentInfoSchema = z.object({
  id: z.string(),
  /** 对应 AgentProfile.id，供前端合并 profile 信息（provider 等） */
  roleId: z.string(),
  name: z.string(),
  status: z.string(),
  currentWorkUnitId: z.string().nullable(),
  startedAt: z.string(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  /** 当前 WU 快照（无 currentWorkUnitId 或 WU 已不存在 → null） */
  currentWorkUnit: agentCurrentWorkUnitSchema.nullable(),
  /** 归属 PMO（解析不到 → null） */
  pmo: agentPmoSummarySchema.nullable(),
  /** 当前 WU 所在频道（无当前 WU → null） */
  channelId: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof agentInfoSchema>;

/** GET /agents 响应 data */
export const agentSummarySchema = z.object({
  agents: z.array(agentInfoSchema),
  summary: z.object({
    total: z.number(),
    idle: z.number(),
    active: z.number(),
    error: z.number(),
    terminated: z.number(),
  }),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

// ── 实体：/stats ──

/** GET /stats 响应 data（前端按必填消费） */
export const monitoringStatsSchema = z.object({
  workunits: z.object({
    total: z.number(),
    unassigned: z.number(),
    active: z.number(),
    in_review: z.number(),
    done: z.number(),
    blocked: z.number(),
    closed: z.number(),
  }),
  agents: z.object({
    total: z.number(),
    idle: z.number(),
    active: z.number(),
    terminated: z.number(),
  }),
  recent: z.object({
    completedLast24h: z.number(),
    failedLast24h: z.number(),
  }),
});
export type MonitoringStats = z.infer<typeof monitoringStatsSchema>;

// ── 实体：/flywheel（M1）与 /overhead（M2）──

/** 指标数据来源：'events' 实算 / 'insufficient-data' 显式 0/null 占位（不编造） */
export const metricsSourceSchema = z.enum(['events', 'insufficient-data']);
export type MetricsSource = z.infer<typeof metricsSourceSchema>;

/** M1 飞轮指标（前端 MonitoringPage 按必填消费） */
export const flywheelStatsSchema = z.object({
  quality: z.number(),
  hitRate: z.number(),
  improvement: z.number(),
  freshness: z.number(),
  source: metricsSourceSchema,
  /** maturity=draft 的 proposal 数（审核前不参与注入） */
  proposalsPendingReview: z.number(),
  extraction: z.object({ count30d: z.number(), totalTokens30d: z.number() }),
  windowDays: z.number(),
  timestamp: z.string(),
});
export type FlywheelStats = z.infer<typeof flywheelStatsSchema>;

/** M2 封装开销（前端 MonitoringPage/WorkUnitDrawer 按必填消费） */
export const overheadStatsSchema = z.object({
  windowDays: z.number(),
  /** workunit:tokens 事件数（每次 CLI 执行完成写一条） */
  executions: z.number(),
  /** 涉及的 distinct workUnit 数 */
  workUnits: z.number(),
  /** 平均每任务注入估算 tokens（estimateTokens 口径） */
  avgInjectedTokens: z.number(),
  /** 注入红线 = 927（INJECTED_TOKEN_BUDGET） */
  injectedBudget: z.number(),
  /** avgInjectedTokens / injectedBudget × 100（>100 即越红线） */
  injectedBudgetUsedPct: z.number(),
  /** 有 CLI usage 回报的执行平均总 tokens；全部未回报 → null（不编造） */
  avgExecutionTokens: z.number().nullable(),
  /** 有执行 tokens 数据的事件占比（0-100） */
  executionCoveragePct: z.number(),
  /** 平均封装开销比 = mean(injectedTokens / executionTokens)；无数据 → null */
  avgOverheadRatio: z.number().nullable(),
  /** 开销比红线 = 0.2 */
  overheadBudget: z.number(),
  /** 窗口内 LLM 提取 tokens 合计（单独核算，不计入注入红线） */
  extractionTokens: z.number(),
  source: metricsSourceSchema,
  timestamp: z.string(),
});
export type OverheadStats = z.infer<typeof overheadStatsSchema>;

// ── 实体：/overview（D16 九组 + #456 stuck/failure24h + F6 evidence）──

export const percentileSchema = z.object({
  count: z.number(),
  /** P50（小时，1 位小数；无数据 → null） */
  p50Hours: z.number().nullable(),
  /** P95（小时，1 位小数；无数据 → null） */
  p95Hours: z.number().nullable(),
});
export type Percentile = z.infer<typeof percentileSchema>;

export const taskFlowMetricsSchema = z.object({
  description: z.string(),
  byStatus: z.record(z.string(), z.number()),
  dwell: percentileSchema.extend({ description: z.string() }),
  createToClaim: percentileSchema.extend({ description: z.string() }),
  claimToComplete: percentileSchema.extend({ description: z.string() }),
  failuresByErrorType: z.object({
    description: z.string(),
    buckets: z.record(z.string(), z.number()),
  }),
  steps: z.object({
    description: z.string(),
    count: z.number(),
    avgStepCount: z.number().nullable(),
    stuckWorkUnits: z.number(),
    avgStuckSteps: z.number().nullable(),
  }),
});
export type TaskFlowMetrics = z.infer<typeof taskFlowMetricsSchema>;

export const intakeMetricsSchema = z.object({
  description: z.string(),
  humanMessages: z.number(),
  workUnitsCreated: z.number(),
  /** 转化率 %（created/humanMessages；无消息 → null 不编造） */
  conversionPct: z.number().nullable(),
});
export type IntakeMetrics = z.infer<typeof intakeMetricsSchema>;

/** 人工干预指标（前端 MonitoringPage 按必填消费） */
export const humanInterventionMetricsSchema = z.object({
  description: z.string(),
  /** 窗口内完成的 WU 数（分母） */
  completedWorkUnits: z.number(),
  needInputCount: z.number(),
  /** review 驳回次数（含 dispatcher 自动驳回，数据源无法区分） */
  reviewRejections: z.number(),
  mergeConflicts: z.number(),
  /** 北极星：每完成 WU 的平均人工干预次数；无完成 → null 不编造 */
  avgPerCompletedWu: z.number().nullable(),
});
export type HumanInterventionMetrics = z.infer<typeof humanInterventionMetricsSchema>;

export const cycleTimeMetricsSchema = z.object({
  description: z.string(),
  createToDone: percentileSchema,
  avgHours: z.number().nullable(),
});
export type CycleTimeMetrics = z.infer<typeof cycleTimeMetricsSchema>;

export const roleMetricsEntrySchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  claims: z.number(),
  completions: z.number(),
  avgDurationHours: z.number().nullable(),
  /** NEED_INPUT：澄清期（waitingReason='ownership'） */
  needInputClarify: z.number(),
  /** NEED_INPUT：执行期（执行中 agent 提问） */
  needInputExecution: z.number(),
});

/** 角色维度指标（前端 MonitoringPage 按必填消费 roles 数组项） */
export const roleMetricsSchema = z.object({
  description: z.string(),
  roles: z.array(roleMetricsEntrySchema),
});
export type RoleMetrics = z.infer<typeof roleMetricsSchema>;

export const qualityMetricsSchema = z.object({
  description: z.string(),
  verifyPassed: z.number(),
  verifyFailing: z.number(),
  verifyPassRatePct: z.number().nullable(),
  mergeConflicts: z.number(),
  merges: z.number(),
});
export type QualityMetrics = z.infer<typeof qualityMetricsSchema>;

export const tokenMetricsSchema = z.object({
  description: z.string(),
  totals: z.object({
    injectedTokens: z.number(),
    executionTokens: z.number(),
    totalTokens: z.number(),
  }),
  workUnits: z.number(),
  avgTokensPerWu: z.number().nullable(),
  cacheHitRatePct: z.number().nullable(),
  cacheCoveragePct: z.number(),
  byRole: z.array(z.object({
    profileId: z.string(),
    profileName: z.string(),
    injectedTokens: z.number(),
    executionTokens: z.number(),
    totalTokens: z.number(),
    workUnits: z.number(),
  })),
});
export type TokenMetrics = z.infer<typeof tokenMetricsSchema>;

/** 告警指标（前端按必填消费 alerts.last24h） */
export const alertMetricsSchema = z.object({
  description: z.string(),
  /** 近 24h 告警数（信噪比基础数据） */
  last24h: z.number(),
  inWindow: z.number(),
  byLevel: z.record(z.string(), z.number()),
});
export type AlertMetrics = z.infer<typeof alertMetricsSchema>;

/** #456 行动面卡住计数（监控页「需要处理」区服务端单源；纯快照派生。
 * 前端 NeedsAttentionSection 按必填消费） */
export const stuckMetricsSchema = z.object({
  description: z.string(),
  blocked: z.number(),
  staleUnassigned: z.number(),
  stalledActive: z.number(),
});
export type StuckMetrics = z.infer<typeof stuckMetricsSchema>;

/** #456 近 24h 失败趋势（前端 NeedsAttentionSection 按必填消费） */
export const failure24hMetricsSchema = z.object({
  description: z.string(),
  n: z.number(),
  /** 近 24h 失败率；null = 窗口内无执行样本 */
  rate: z.number().nullable(),
  /** 近 24h vs 前 24h；null = 前窗口无样本无法比 */
  trend: z.enum(['up', 'down', 'flat']).nullable(),
});
export type Failure24hMetrics = z.infer<typeof failure24hMetricsSchema>;

/** F6 证据台账指标（前端 MonitoringPage 按必填消费） */
export const evidenceMetricsSchema = z.object({
  description: z.string(),
  engaged: z.number(),
  l1Approved: z.number(),
  l2Approved: z.number(),
  l3Approved: z.number(),
  selfReviewCount: z.number(),
  needsHuman: z.number(),
  /** metadata/receipt 自相矛盾的代码 WU 数（不探测真实 Git drift） */
  mergeDivergence: z.number(),
  /** legacy done 且无 merge receipt 的代码 WU 数 */
  doneWithoutReceipt: z.number(),
  /** 双轨比对：派生列 ≠ 存储状态的 WU 数 */
  derivedMismatch: z.number(),
  derivedByColumn: z.record(z.string(), z.number()),
});
export type EvidenceMetrics = z.infer<typeof evidenceMetricsSchema>;

/** #707：Effect/Receipt 当前快照与恢复核查指标。 */
export const effectMetricsSchema = z.object({
  description: z.string(),
  byStatus: z.record(z.string(), z.number()),
  receiptsByOutcome: z.record(z.string(), z.number()),
  recoveryChecks: z.number().int().nonnegative(),
  duplicatesPrevented: z.number().int().nonnegative(),
});
export type EffectMetrics = z.infer<typeof effectMetricsSchema>;

/** GET /overview 响应 data（前端只消费 evidence/roles/humanIntervention/alerts/stuck/failure24h
 * 六段，其余段落正本声明不裁剪） */
export const overviewMetricsSchema = z.object({
  windowDays: z.number(),
  generatedAt: z.string(),
  taskFlow: taskFlowMetricsSchema,
  intake: intakeMetricsSchema,
  humanIntervention: humanInterventionMetricsSchema,
  cycleTime: cycleTimeMetricsSchema,
  roles: roleMetricsSchema,
  quality: qualityMetricsSchema,
  tokens: tokenMetricsSchema,
  alerts: alertMetricsSchema,
  stuck: stuckMetricsSchema,
  failure24h: failure24hMetricsSchema,
  evidence: evidenceMetricsSchema,
  effects: effectMetricsSchema,
  source: metricsSourceSchema,
});
export type OverviewMetrics = z.infer<typeof overviewMetricsSchema>;

// ── 实体：/efficiency（#120）──

/** 单步缓存命中率（前端 MonitoringPage 按必填消费） */
export const stepCacheHitRateSchema = z.object({
  executionId: z.string().nullable(),
  workUnitId: z.string().nullable(),
  createdAt: z.string(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  /** 命中率 %（cacheRead/(input+cacheRead)；分母 0 → null） */
  hitRatePct: z.number().nullable(),
});
export type StepCacheHitRate = z.infer<typeof stepCacheHitRateSchema>;

/** 缓存命中率聚合桶（前端按必填消费） */
export const cacheHitRateBucketSchema = z.object({
  cacheReadTokens: z.number(),
  inputTokens: z.number(),
  hitRatePct: z.number().nullable(),
  events: z.number(),
});
export type CacheHitRateBucket = z.infer<typeof cacheHitRateBucketSchema>;

/** #120 输入缓存命中率指标（前端 MonitoringPage 按必填消费 overall/byDay/byRole） */
export const cacheHitRateMetricsSchema = z.object({
  description: z.string(),
  windowDays: z.number(),
  overall: cacheHitRateBucketSchema.extend({ workUnits: z.number() }),
  steps: z.array(stepCacheHitRateSchema),
  byWorkUnit: z.array(cacheHitRateBucketSchema.extend({ workUnitId: z.string() })),
  byRole: z.array(cacheHitRateBucketSchema.extend({
    profileId: z.string(),
    profileName: z.string(),
  })),
  byDay: z.array(cacheHitRateBucketSchema.extend({ day: z.string() })),
  coveragePct: z.number(),
  source: metricsSourceSchema,
});
export type CacheHitRateMetrics = z.infer<typeof cacheHitRateMetricsSchema>;

export const sectionTrimBucketSchema = z.object({
  section: z.string(),
  trimCount: z.number(),
  avgOriginalTokens: z.number(),
  avgTrimmedTokens: z.number(),
  avgTrimPct: z.number(),
});
export type SectionTrimBucket = z.infer<typeof sectionTrimBucketSchema>;

/** #120 段 trim 率指标（前端按必填消费） */
export const sectionTrimMetricsSchema = z.object({
  description: z.string(),
  windowDays: z.number(),
  bySection: z.array(sectionTrimBucketSchema),
  totals: z.object({
    trimEvents: z.number(),
    totalOriginalTokens: z.number(),
    totalTrimmedTokens: z.number(),
  }),
  source: metricsSourceSchema,
});
export type SectionTrimMetrics = z.infer<typeof sectionTrimMetricsSchema>;

/** GET /efficiency 响应 data */
export const efficiencyMetricsSchema = z.object({
  windowDays: z.number(),
  generatedAt: z.string(),
  cacheHitRate: cacheHitRateMetricsSchema,
  sectionTrim: sectionTrimMetricsSchema,
});
export type EfficiencyMetrics = z.infer<typeof efficiencyMetricsSchema>;

// ── 请求 ──

/** GET /overview 与 /efficiency 共用（windowDays 缺省 7、1-90 clamp、非数值 → 缺省，均在 handler） */
export const monitoringWindowQuerySchema = z.object({
  windowDays: z.string().optional(),
});
export type MonitoringWindowQuery = z.infer<typeof monitoringWindowQuerySchema>;

// ── 响应（统一 `{ data }` 壳）──

export const agentSummaryResponseSchema = dataBodySchema(agentSummarySchema);
export const monitoringStatsResponseSchema = dataBodySchema(monitoringStatsSchema);
export const flywheelStatsResponseSchema = dataBodySchema(flywheelStatsSchema);
export const overheadStatsResponseSchema = dataBodySchema(overheadStatsSchema);
export const overviewMetricsResponseSchema = dataBodySchema(overviewMetricsSchema);
export const efficiencyMetricsResponseSchema = dataBodySchema(efficiencyMetricsSchema);
