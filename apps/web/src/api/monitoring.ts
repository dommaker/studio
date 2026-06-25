// Monitoring API — Agent Network (MVP-2 + MVP-6)
import { api } from './index';

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: string;
}

export interface AgentSummary {
  agents: AgentInfo[];
  summary: {
    total: number;
    idle: number;
    active: number;
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

export const monitoringApi = {
  getAgentSummary: () => api.get<AgentSummary>('/monitoring/agents'),
  getStats: () => api.get<MonitoringStats>('/monitoring/stats'),
};
