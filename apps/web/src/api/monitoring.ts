// Monitoring API — Agent Network (MVP-2 + MVP-6)
//
// 契约驱动迁移（2026-10 批次 5/7）：16 个手抄 interface 全部删除改 contract
// import（别名保持旧名：AgentPmoRef=AgentPmoSummary、EvidenceStats=EvidenceMetrics、
// CacheHitRateStats=CacheHitRateMetrics、SectionTrimStats=SectionTrimMetrics、
// EfficiencyStats=EfficiencyMetrics）；响应统一 `{ data }` 壳（原裸对象），消费方
// 解包 res.data → res.data.data。terminateInstance/getAgentInstance 属 agents 域
// 端点（本批不迁），保持原样；MonitoringPage 多处直接调用只收口类型与解包，
// 数据获取范式统一归 Phase 3。
import type {
  AgentCurrentWorkUnit,
  AgentPmoSummary,
  AgentInfo,
  AgentSummary,
  MonitoringStats,
  FlywheelStats,
  OverheadStats,
  EvidenceMetrics,
  CacheHitRateBucket,
  StepCacheHitRate,
  CacheHitRateMetrics,
  SectionTrimMetrics,
  RoleMetrics,
  HumanInterventionMetrics,
  EfficiencyMetrics,
  OverviewMetrics,
} from '@dommaker/studio-contract';
import { api } from './index';

export type {
  AgentCurrentWorkUnit,
  AgentInfo,
  AgentSummary,
  MonitoringStats,
  FlywheelStats,
  OverheadStats,
  CacheHitRateBucket,
  StepCacheHitRate,
  RoleMetrics,
  HumanInterventionMetrics,
};
/** instance 当前 WU 归属的 PMO 项目（PMO 即 REQ 只读别名；契约名 AgentPmoSummary） */
export type AgentPmoRef = AgentPmoSummary;
/** F6（决策 1）证据台账（/monitoring/overview 的 evidence 段；契约名 EvidenceMetrics） */
export type EvidenceStats = EvidenceMetrics;
/** #120：输入缓存命中率（步/WU/角色/天；契约名 CacheHitRateMetrics） */
export type CacheHitRateStats = CacheHitRateMetrics;
/** #120：段 trim 率（按段计数；契约名 SectionTrimMetrics） */
export type SectionTrimStats = SectionTrimMetrics;
/** #120：/monitoring/efficiency（契约名 EfficiencyMetrics） */
export type EfficiencyStats = EfficiencyMetrics;

/** #290（清单 #24）：RuntimeInstance 档案（agents 域端点，本批不迁，本地声明保留） */
export interface AgentInstanceInfo {
  id: string;
  roleId: string;
  status: string;
}

export const monitoringApi = {
  getAgentSummary: () => api.get<{ data: AgentSummary }>('/monitoring/agents'),
  getStats: () => api.get<{ data: MonitoringStats }>('/monitoring/stats'),
  getFlywheel: () => api.get<{ data: FlywheelStats }>('/monitoring/flywheel'),
  getOverhead: () => api.get<{ data: OverheadStats }>('/monitoring/overhead'),
  /** F6：概览（#398 起消费 evidence + roles + humanIntervention 三段；E4 增 alerts.last24h 供顶栏待处理徽标；#456 增 stuck/failure24h 供「需要处理」区；契约声明全部九组，消费方仍只读这几段） */
  getOverview: () => api.get<{ data: OverviewMetrics }>('/monitoring/overview'),
  /** #120：输入缓存命中率（步/WU/角色/天）+ 段 trim 率（按段） */
  getEfficiency: () => api.get<{ data: EfficiencyMetrics }>('/monitoring/efficiency'),
  /** 强制停止实例（当前任务转人工处理；AgentDashboardPage / AgentDetailPage 共用） */
  terminateInstance: (instanceId: string) =>
    api.post(`/agent-instances/${instanceId}/terminate`),
  /** #290（清单 #24）：单个 RuntimeInstance 档案（负责人离线回退解析 roleId） */
  getAgentInstance: (instanceId: string) =>
    api.get<AgentInstanceInfo>(`/agent-instances/${instanceId}`),
};
