// Triage Agent 类型定义（P2-d 自 agents/types.ts 拆分，随 triage 子系统归属）

export type TriageIncidentType =
  // 系统级（已有）
  | 'service_down'
  | 'resource_critical'
  | 'ext_dependency'
  | 'zombie'
  // 执行级（Monitor 升级，Phase 1）
  | 'execution_repeated_failure'
  | 'execution_stuck'
  | 'execution_progress_stagnation'
  | 'execution_heartbeat_lost'
  | 'execution_session_exhausted'
  | 'execution_timeout'
  // 跨执行模式（Auditor/Evolution 升级，Phase 3）
  | 'agent_type_failure_trend'
  | 'workunit_health_degraded'
  | 'review_cycle_exhausted'
  // 系统健康
  | 'knowledge_health_degraded';

export interface TriageIncidentInput {
  type: TriageIncidentType;
  severity: 'critical' | 'warning';
  message: string;
  details?: Record<string, unknown>;
}

export interface TriageLogEntry {
  time: string;
  phase: 'diagnose' | 'classify' | 'act' | 'resolve' | 'escalate';
  action: string;
  result: string;
  durationMs?: number;
}
