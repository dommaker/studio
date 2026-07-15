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

// ── ReviewDiff (parameterized diff review, topology-agnostic) ──

export interface ReviewDiffParams {
  baseRef: string;
  headRef: string;
  repoPath: string;
  description?: string;
  acceptanceCriteria?: string[];
  stances?: { id: string; name: string; prompt: string; reviewerFocus?: string }[];
}

// ── MergeBranches (topology-agnostic) ──

export interface MergeBranchesParams {
  source: string;
  target: string;
  repoPath?: string;
  push?: boolean;
}

export interface MergeBranchesResult {
  success: boolean;
  merged: boolean;
  pushed: boolean;
  summary: string;
}

// ── MergeToMaster (convenience composite) ──

export interface MergeToMasterRequest {
  sourceBranch?: string;
  skipReview?: boolean;
  environment?: 'vps' | 'company_frontend' | 'company_backend';
}

export interface MergeToMasterResult {
  reviewApproved: boolean;
  reviewScore: number;
  reviewIssues: ReviewIssue[];
  merged: boolean;
  pushed: boolean;
  summary: string;
}

// ── Existing ──

export interface ReviewResult {
  approved: boolean;
  score: number;
  issues: ReviewIssue[];
  suggestions: string[];
  /** TDD-08: Reviewer 补写的边界测试文件（保留到测试套件） */
  supplementaryTestFiles?: { file: string; content: string }[];
  /** TDD-09: AC 覆盖率报告 */
  acCoverage?: { total: number; covered: number; missing: string[] };
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
  | 'heartbeat_loss'
  | 'tool_error_rate'
  | 'tool_zero_success'
  | 'session_file_size'
  | 'review_quality'
  | 'deploy_push_failed'
  | 'proxy_restart_exhausted';

export interface MonitorAlert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  source: MonitorAlertSource;
  timestamp?: number;
  projectId?: string;
  relatedTaskIds?: string[];
}
