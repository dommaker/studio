// Monitoring API — Agent Network (MVP-2 + MVP-6)
import { api } from './index';

/** 2026-07-31 全流程串联（§6.1）：instance 当前 WU 聚合信息（后端并行落地中，字段可能暂缺，消费方防御性处理） */
export interface AgentCurrentWorkUnit {
  id: string;
  title: string;
  type: string;
  status: string;
  claimedAt: string | null;
}

/** instance 当前 WU 归属的 PMO 项目（PMO 即 REQ 只读别名） */
export interface AgentPmoRef {
  id: string;
  pmoNumber: string;
  title: string;
}

export interface AgentInfo {
  id: string;
  /** 对应 AgentProfile.id，用于与 profile（provider 等）合并展示 */
  roleId: string;
  name: string;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: string;
  lastError?: string | null;
  lastErrorAt?: string | null;
  /** §6.1 聚合：当前 WU 详情（无任务或后端未上线时为 null/undefined） */
  currentWorkUnit?: AgentCurrentWorkUnit | null;
  /** §6.1 聚合：当前 WU 所属 PMO */
  pmo?: AgentPmoRef | null;
  /** §6.1 聚合：instance 所在频道 */
  channelId?: string | null;
}

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

/** #290（清单 #24）：RuntimeInstance 档案（离线实例兜底解析负责人角色用） */
export interface AgentInstanceInfo {
  id: string;
  roleId: string;
  status: string;
}

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

/** M1: 飞轮指标（/monitoring/flywheel） */
export interface FlywheelStats {
  quality: number;
  hitRate: number;
  improvement: number;
  freshness: number;
  source: 'events' | 'insufficient-data';
  proposalsPendingReview: number;
  extraction: { count30d: number; totalTokens30d: number };
  windowDays: number;
  timestamp: string;
}

/** M2: 封装开销（/monitoring/overhead） */
export interface OverheadStats {
  windowDays: number;
  executions: number;
  workUnits: number;
  avgInjectedTokens: number;
  injectedBudget: number;
  injectedBudgetUsedPct: number;
  avgExecutionTokens: number | null;
  executionCoveragePct: number;
  avgOverheadRatio: number | null;
  overheadBudget: number;
  extractionTokens: number;
  source: 'events' | 'insufficient-data';
  timestamp: string;
}

/** F6（决策 1）证据台账（/monitoring/overview 的 evidence 段） */
export interface EvidenceStats {
  engaged: number;
  l1Approved: number;
  l2Approved: number;
  l3Approved: number;
  selfReviewCount: number;
  needsHuman: number;
  derivedMismatch: number;
  derivedByColumn: Record<string, number>;
}

/** #120：输入缓存命中率分桶（/monitoring/efficiency） */
export interface CacheHitRateBucket {
  cacheReadTokens: number;
  inputTokens: number;
  hitRatePct: number | null;
  events: number;
}

/** #120：单步命中数据点 */
export interface StepCacheHitRate {
  executionId: string | null;
  workUnitId: string | null;
  createdAt: string;
  inputTokens: number;
  cacheReadTokens: number;
  hitRatePct: number | null;
}

/** #120：输入缓存命中率（步/WU/角色/天） */
export interface CacheHitRateStats {
  description: string;
  windowDays: number;
  overall: CacheHitRateBucket & { workUnits: number };
  steps: StepCacheHitRate[];
  byWorkUnit: Array<{ workUnitId: string } & CacheHitRateBucket>;
  byRole: Array<{ profileId: string; profileName: string } & CacheHitRateBucket>;
  byDay: Array<{ day: string } & CacheHitRateBucket>;
  coveragePct: number;
  source: 'events' | 'insufficient-data';
}

/** #120：段 trim 率（按段计数） */
export interface SectionTrimStats {
  description: string;
  windowDays: number;
  bySection: Array<{ section: string; trimCount: number; avgOriginalTokens: number; avgTrimmedTokens: number; avgTrimPct: number }>;
  totals: { trimEvents: number; totalOriginalTokens: number; totalTrimmedTokens: number };
  source: 'events' | 'insufficient-data';
}

/** #120：/monitoring/efficiency —— 输入缓存命中率 + 段 trim 率 */
export interface EfficiencyStats {
  windowDays: number;
  generatedAt: string;
  cacheHitRate: CacheHitRateStats;
  sectionTrim: SectionTrimStats;
}

export const monitoringApi = {
  getAgentSummary: () => api.get<AgentSummary>('/monitoring/agents'),
  getStats: () => api.get<MonitoringStats>('/monitoring/stats'),
  getFlywheel: () => api.get<FlywheelStats>('/monitoring/flywheel'),
  getOverhead: () => api.get<OverheadStats>('/monitoring/overhead'),
  /** F6：概览（只消费 evidence 段，其余字段不声明不依赖） */
  getOverview: () => api.get<{ evidence: EvidenceStats }>('/monitoring/overview'),
  /** #120：输入缓存命中率（步/WU/角色/天）+ 段 trim 率（按段） */
  getEfficiency: () => api.get<EfficiencyStats>('/monitoring/efficiency'),
  /** 强制停止实例（当前任务转人工处理；AgentDashboardPage / AgentDetailPage 共用） */
  terminateInstance: (instanceId: string) =>
    api.post(`/agent-instances/${instanceId}/terminate`),
  /** #290（清单 #24）：单个 RuntimeInstance 档案（负责人离线回退解析 roleId） */
  getAgentInstance: (instanceId: string) =>
    api.get<AgentInstanceInfo>(`/agent-instances/${instanceId}`),
};
