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
  | 'pipeline_health_degraded'
  | 'review_cycle_exhausted';

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

// ── Deploy Agent ──

export interface DeployParams {
  projectId: string;
  executionId: string;
  worktree: string;
  environment: 'vps' | 'company_frontend' | 'company_backend';
  taskDescription: string;
}

export interface DeployFinding {
  severity: 'info' | 'warning' | 'blocker';
  category: 'ac_completion' | 'sql_change' | 'dependency_change' | 'general';
  message: string;
}

export interface DeployResult {
  success: boolean;
  type: 'vps' | 'company_frontend' | 'company_backend';
  findings: DeployFinding[];
  artifact?: string;
  summary: string;
}

// ── Existing ──

export interface ReviewResult {
  approved: boolean;
  score: number;
  issues: ReviewIssue[];
  suggestions: string[];
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
}

export interface KnowledgeExtraction {
  entries: KnowledgeEntryDraft[];
}

export interface KnowledgeEntryDraft {
  type: 'decision' | 'pitfall' | 'guideline' | 'model';
  title: string;
  content: string;
  tags: string[];
}

export type MonitorAlertSource =
  | 'failure_trend'
  | 'stuck_goals'
  | 'progress_stagnation'
  | 'session_escalation'
  | 'total_time'
  | 'heartbeat_loss'
  | 'tool_error_rate'
  | 'tool_zero_success';

export interface MonitorAlert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  source: MonitorAlertSource;
  timestamp?: number;
  projectId?: string;
  relatedTaskIds?: string[];
}
