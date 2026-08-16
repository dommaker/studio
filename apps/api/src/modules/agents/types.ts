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
  | 'wu_index_reconcile' // #170（决策 #65-3）：启动对账 events vs index 分叉告警
  | 'agent_timeout_scan' // #179（#66 决议 3）：心跳过期但 pid 活（疑似 FileStore 故障）告警
  | 'pool_stagnation' // #181（决策 #62 D2）：unassigned 池滞留（指名未认领区分出声）
  | 'review_stagnation' // #181（决策 #167③）：in_review 滞留待人工确认
  | 'analysis_respawn' // #183（#159）：analysis 派工断链对账补建（3 次仍败升 critical）
  | 'review_redispatch' // #183（#66 决议①）：review 断链对账重跑（3 次仍败升 critical）
  | 'analysis_confirm'; // #186（#167 决议 2）：无频道 analysis 确认提示投 Web「需要处理」收件箱

export interface MonitorAlert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  source: MonitorAlertSource;
  timestamp?: number;
  projectId?: string;
  relatedTaskIds?: string[];
}
