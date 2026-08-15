// Agent 团队类型定义

// ── Triage Agent ──

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

// ── Existing ──

export interface KnowledgeExtraction {
  entries: KnowledgeEntryDraft[];
}

export interface KnowledgeEntryDraft {
  type: 'decision' | 'pitfall' | 'guideline' | 'model' | 'architecture' | 'process';
  title: string;
  content: string;
  tags: string[];
}

export type MonitorAlertSource =
  | 'failure_trend'
  | 'stuck_workunits'
  | 'progress_stagnation'
  | 'session_escalation'
  | 'total_time'
  | 'tool_error_rate'
  | 'tool_zero_success'
  | 'session_file_size'
  | 'lock'; // #169: FileStore 锁 stale 回收/获锁超时（仅 warning，不升级 Triage）

export interface MonitorAlert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  source: MonitorAlertSource;
  timestamp?: number;
  projectId?: string;
  relatedTaskIds?: string[];
}
