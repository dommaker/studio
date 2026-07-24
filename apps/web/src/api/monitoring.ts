// Monitoring API — Agent Network (MVP-2 + MVP-6)
import { api } from './index';

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

export const monitoringApi = {
  getAgentSummary: () => api.get<AgentSummary>('/monitoring/agents'),
  getStats: () => api.get<MonitoringStats>('/monitoring/stats'),
  getFlywheel: () => api.get<FlywheelStats>('/monitoring/flywheel'),
  getOverhead: () => api.get<OverheadStats>('/monitoring/overhead'),
};
