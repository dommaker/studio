/**
 * monitoring 域契约——正本以 apps/api/src/modules/monitoring/ 实测 wire 为准：
 * monitoring.service.ts（AgentSummary/MonitoringStats/FlywheelStats/OverheadStats）、
 * current-wu-context.ts（AgentCurrentWorkUnit/AgentPmoSummary）、
 * metrics.types.ts（D16 OverviewMetrics 九组 + #120 EfficiencyMetrics）。
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

/** 手写 interface（前端 rosterStore/useAgentRoster/ProjectPipeline 按必填消费）；parity 测试见 __tests__ */
export interface AgentCurrentWorkUnit {
  id: string;
  /** metadata.title ?? scope（原样，不截断） */
  title: string;
  type: string;
  status: string;
  claimedAt: string | null;
}
export const agentCurrentWorkUnitSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  claimedAt: z.string().nullable(),
});

/** 手写 interface（前端 rosterStore/ProjectPipeline 按必填消费；前端别名 AgentPmoRef）；parity 测试见 __tests__ */
export interface AgentPmoSummary {
  id: string;
  pmoNumber: string;
  title: string;
}
export const agentPmoSummarySchema = z.object({
  id: z.string(),
  pmoNumber: z.string(),
  title: z.string(),
});

/** 手写 interface（前端 rosterStore 合成/合并条目按必填消费）；parity 测试见 __tests__ */
export interface AgentInfo {
  id: string;
  /** 对应 AgentProfile.id，供前端合并 profile 信息（provider 等） */
  roleId: string;
  name: string;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: string;
  lastError: string | null;
  lastErrorAt: string | null;
  /** 当前 WU 快照（无 currentWorkUnitId 或 WU 已不存在 → null） */
  currentWorkUnit: AgentCurrentWorkUnit | null;
  /** 归属 PMO（解析不到 → null） */
  pmo: AgentPmoSummary | null;
  /** 当前 WU 所在频道（无当前 WU → null） */
  channelId: string | null;
}
export const agentInfoSchema = z.object({
  id: z.string(),
  roleId: z.string(),
  name: z.string(),
  status: z.string(),
  currentWorkUnitId: z.string().nullable(),
  startedAt: z.string(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  currentWorkUnit: agentCurrentWorkUnitSchema.nullable(),
  pmo: agentPmoSummarySchema.nullable(),
  channelId: z.string().nullable(),
});

/** GET /agents 响应 data（手写：agents 为手写实体数组） */
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
export interface AgentSummary {
  agents: AgentInfo[];
  summary: {
    total: number;
    idle: number;
    active: number;
    error: number;
    terminated: number;
  };
}

// ── 实体：/stats ──

/** 手写 interface（前端按必填消费）；parity 测试见 __tests__ */
export interface MonitoringStats {
  workunits: {
    total: number;
    unassigned: number;
    active: number;
    in_review: number;
    done: number;
    blocked: number;
    closed: number;
  };
  agents: {
    total: number;
    idle: number;
    active: number;
    terminated: number;
  };
  recent: {
    completedLast24h: number;
    failedLast24h: number;
  };
}
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

// ── 实体：/flywheel（M1）与 /overhead（M2）──

/** 指标数据来源：'events' 实算 / 'insufficient-data' 显式 0/null 占位（不编造） */
export const metricsSourceSchema = z.enum(['events', 'insufficient-data']);
export type MetricsSource = z.infer<typeof metricsSourceSchema>;

/** 手写 interface（前端 MonitoringPage 按必填消费）；parity 测试见 __tests__ */
export interface FlywheelStats {
  quality: number;
  hitRate: number;
  improvement: number;
  freshness: number;
  source: MetricsSource;
  /** maturity=draft 的 proposal 数（审核前不参与注入） */
  proposalsPendingReview: number;
  extraction: { count30d: number; totalTokens30d: number };
  windowDays: number;
  timestamp: string;
}
export const flywheelStatsSchema = z.object({
  quality: z.number(),
  hitRate: z.number(),
  improvement: z.number(),
  freshness: z.number(),
  source: metricsSourceSchema,
  proposalsPendingReview: z.number(),
  extraction: z.object({ count30d: z.number(), totalTokens30d: z.number() }),
  windowDays: z.number(),
  timestamp: z.string(),
});

/** 手写 interface（前端 MonitoringPage/WorkUnitDrawer 按必填消费）；parity 测试见 __tests__ */
export interface OverheadStats {
  windowDays: number;
  /** workunit:tokens 事件数（每次 CLI 执行完成写一条） */
  executions: number;
  /** 涉及的 distinct workUnit 数 */
  workUnits: number;
  /** 平均每任务注入估算 tokens（estimateTokens 口径） */
  avgInjectedTokens: number;
  /** 注入红线 = 927（INJECTED_TOKEN_BUDGET） */
  injectedBudget: number;
  /** avgInjectedTokens / injectedBudget × 100（>100 即越红线） */
  injectedBudgetUsedPct: number;
  /** 有 CLI usage 回报的执行平均总 tokens；全部未回报 → null（不编造） */
  avgExecutionTokens: number | null;
  /** 有执行 tokens 数据的事件占比（0-100） */
  executionCoveragePct: number;
  /** 平均封装开销比 = mean(injectedTokens / executionTokens)；无数据 → null */
  avgOverheadRatio: number | null;
  /** 开销比红线 = 0.2 */
  overheadBudget: number;
  /** 窗口内 LLM 提取 tokens 合计（单独核算，不计入注入红线） */
  extractionTokens: number;
  source: MetricsSource;
  timestamp: string;
}
export const overheadStatsSchema = z.object({
  windowDays: z.number(),
  executions: z.number(),
  workUnits: z.number(),
  avgInjectedTokens: z.number(),
  injectedBudget: z.number(),
  injectedBudgetUsedPct: z.number(),
  avgExecutionTokens: z.number().nullable(),
  executionCoveragePct: z.number(),
  avgOverheadRatio: z.number().nullable(),
  overheadBudget: z.number(),
  extractionTokens: z.number(),
  source: metricsSourceSchema,
  timestamp: z.string(),
});

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
  byStatus: z.record(z.number()),
  dwell: percentileSchema.extend({ description: z.string() }),
  createToClaim: percentileSchema.extend({ description: z.string() }),
  claimToComplete: percentileSchema.extend({ description: z.string() }),
  failuresByErrorType: z.object({
    description: z.string(),
    buckets: z.record(z.number()),
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

/** 手写 interface（前端 MonitoringPage 按必填消费）；parity 测试见 __tests__ */
export interface HumanInterventionMetrics {
  description: string;
  /** 窗口内完成的 WU 数（分母） */
  completedWorkUnits: number;
  needInputCount: number;
  /** review 驳回次数（含 dispatcher 自动驳回，数据源无法区分） */
  reviewRejections: number;
  mergeConflicts: number;
  /** 北极星：每完成 WU 的平均人工干预次数；无完成 → null 不编造 */
  avgPerCompletedWu: number | null;
}
export const humanInterventionMetricsSchema = z.object({
  description: z.string(),
  completedWorkUnits: z.number(),
  needInputCount: z.number(),
  reviewRejections: z.number(),
  mergeConflicts: z.number(),
  avgPerCompletedWu: z.number().nullable(),
});

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

/** 手写 interface（前端 MonitoringPage 按必填消费 roles 数组项）；parity 测试见 __tests__ */
export interface RoleMetrics {
  description: string;
  roles: Array<{
    profileId: string;
    profileName: string;
    claims: number;
    completions: number;
    avgDurationHours: number | null;
    needInputClarify: number;
    needInputExecution: number;
  }>;
}
export const roleMetricsSchema = z.object({
  description: z.string(),
  roles: z.array(roleMetricsEntrySchema),
});

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

/** 手写 interface（前端按必填消费 alerts.last24h）；parity 测试见 __tests__ */
export interface AlertMetrics {
  description: string;
  /** 近 24h 告警数（信噪比基础数据） */
  last24h: number;
  inWindow: number;
  byLevel: Record<string, number>;
}
export const alertMetricsSchema = z.object({
  description: z.string(),
  last24h: z.number(),
  inWindow: z.number(),
  byLevel: z.record(z.number()),
});

/** #456 行动面卡住计数（监控页「需要处理」区服务端单源；纯快照派生）。
 * 手写 interface（前端 NeedsAttentionSection 按必填消费）；parity 测试见 __tests__ */
export interface StuckMetrics {
  description: string;
  blocked: number;
  staleUnassigned: number;
  stalledActive: number;
}
export const stuckMetricsSchema = z.object({
  description: z.string(),
  blocked: z.number(),
  staleUnassigned: z.number(),
  stalledActive: z.number(),
});

/** #456 近 24h 失败趋势。手写 interface（前端 NeedsAttentionSection 按必填消费）；parity 测试见 __tests__ */
export interface Failure24hMetrics {
  description: string;
  n: number;
  /** 近 24h 失败率；null = 窗口内无执行样本 */
  rate: number | null;
  /** 近 24h vs 前 24h；null = 前窗口无样本无法比 */
  trend: 'up' | 'down' | 'flat' | null;
}
export const failure24hMetricsSchema = z.object({
  description: z.string(),
  n: z.number(),
  rate: z.number().nullable(),
  trend: z.enum(['up', 'down', 'flat']).nullable(),
});

/** F6 证据台账指标。手写 interface（前端 MonitoringPage 按必填消费）；parity 测试见 __tests__ */
export interface EvidenceMetrics {
  description: string;
  engaged: number;
  l1Approved: number;
  l2Approved: number;
  l3Approved: number;
  selfReviewCount: number;
  needsHuman: number;
  /** 双轨比对：派生列 ≠ 存储状态的 WU 数 */
  derivedMismatch: number;
  derivedByColumn: Record<string, number>;
}
export const evidenceMetricsSchema = z.object({
  description: z.string(),
  engaged: z.number(),
  l1Approved: z.number(),
  l2Approved: z.number(),
  l3Approved: z.number(),
  selfReviewCount: z.number(),
  needsHuman: z.number(),
  derivedMismatch: z.number(),
  derivedByColumn: z.record(z.number()),
});

/** GET /overview 响应 data（手写：含手写实体子树；前端只消费
 * evidence/roles/humanIntervention/alerts/stuck/failure24h 六段，其余段落正本声明不裁剪） */
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
  source: metricsSourceSchema,
});
export interface OverviewMetrics {
  windowDays: number;
  generatedAt: string;
  taskFlow: TaskFlowMetrics;
  intake: IntakeMetrics;
  humanIntervention: HumanInterventionMetrics;
  cycleTime: CycleTimeMetrics;
  roles: RoleMetrics;
  quality: QualityMetrics;
  tokens: TokenMetrics;
  alerts: AlertMetrics;
  stuck: StuckMetrics;
  failure24h: Failure24hMetrics;
  evidence: EvidenceMetrics;
  source: MetricsSource;
}

// ── 实体：/efficiency（#120）──

/** 手写 interface（前端 MonitoringPage 按必填消费）；parity 测试见 __tests__ */
export interface StepCacheHitRate {
  executionId: string | null;
  workUnitId: string | null;
  createdAt: string;
  inputTokens: number;
  cacheReadTokens: number;
  /** 命中率 %（cacheRead/(input+cacheRead)；分母 0 → null） */
  hitRatePct: number | null;
}
export const stepCacheHitRateSchema = z.object({
  executionId: z.string().nullable(),
  workUnitId: z.string().nullable(),
  createdAt: z.string(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  hitRatePct: z.number().nullable(),
});

/** 手写 interface（前端按必填消费）；parity 测试见 __tests__ */
export interface CacheHitRateBucket {
  cacheReadTokens: number;
  inputTokens: number;
  hitRatePct: number | null;
  events: number;
}
export const cacheHitRateBucketSchema = z.object({
  cacheReadTokens: z.number(),
  inputTokens: z.number(),
  hitRatePct: z.number().nullable(),
  events: z.number(),
});

/** 手写 interface（前端 MonitoringPage 按必填消费 overall/byDay/byRole）；parity 测试见 __tests__ */
export interface CacheHitRateMetrics {
  description: string;
  windowDays: number;
  overall: CacheHitRateBucket & { workUnits: number };
  steps: StepCacheHitRate[];
  byWorkUnit: Array<{ workUnitId: string } & CacheHitRateBucket>;
  byRole: Array<{ profileId: string; profileName: string } & CacheHitRateBucket>;
  byDay: Array<{ day: string } & CacheHitRateBucket>;
  coveragePct: number;
  source: MetricsSource;
}
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

export const sectionTrimBucketSchema = z.object({
  section: z.string(),
  trimCount: z.number(),
  avgOriginalTokens: z.number(),
  avgTrimmedTokens: z.number(),
  avgTrimPct: z.number(),
});
export type SectionTrimBucket = z.infer<typeof sectionTrimBucketSchema>;

/** 手写 interface（前端按必填消费）；parity 测试见 __tests__ */
export interface SectionTrimMetrics {
  description: string;
  windowDays: number;
  bySection: SectionTrimBucket[];
  totals: { trimEvents: number; totalOriginalTokens: number; totalTrimmedTokens: number };
  source: MetricsSource;
}
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

/** GET /efficiency 响应 data（手写：含手写实体子树） */
export const efficiencyMetricsSchema = z.object({
  windowDays: z.number(),
  generatedAt: z.string(),
  cacheHitRate: cacheHitRateMetricsSchema,
  sectionTrim: sectionTrimMetricsSchema,
});
export interface EfficiencyMetrics {
  windowDays: number;
  generatedAt: string;
  cacheHitRate: CacheHitRateMetrics;
  sectionTrim: SectionTrimMetrics;
}

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
