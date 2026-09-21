/**
 * Resolution types — RKB (Resolution Knowledge Base)
 *
 * 运维配置类知识（错误模式 → 已知解法）的类型定义，由 apps/api
 * ResolutionService 匹配/创建/验证（消费方：Triage、Auditor）。
 *
 * M1（2026-09-21）：maturity/layer 值域对齐 harness 知识 schema——
 * status 取 harness MaturityLevel 子集（draft/verified/proven/deprecated），
 * layer 取 harness StorageLayer（原 L3~L6 分层值退役，改写 'project' 并挪进 tags）。
 */

export interface Resolution {
  id: string;
  pattern: string;
  errorClass: string;
  layer: 'personal' | 'team' | 'tech' | 'domain' | 'project' | 'system';
  title: string;
  fix: string;
  status: 'draft' | 'verified' | 'proven' | 'deprecated';
  verifyCount: number;
  verifiedAt?: string;
  sourceGoalId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateResolutionInput {
  pattern: string;
  errorClass: string;
  layer: Resolution['layer'];
  title: string;
  fix: string;
  sourceGoalId?: string;
  tags?: string[];
}

export interface MatchResolutionInput {
  errorMessage: string;
  errorClass?: string;
}

export interface MatchResolutionResult {
  matched: boolean;
  resolutions: Resolution[];
}
