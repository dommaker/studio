/**
 * Resolution types — RKB (Resolution Knowledge Base)
 *
 * L3~L6 运维配置类知识的类型定义。
 * Resolution 是"错误模式 → 已知解法"的映射，供 agent-executor 在重试时注入 prompt。
 */

export interface Resolution {
  id: string;
  pattern: string;
  errorClass: string;
  layer: 'L3_tool_behavior' | 'L4_env_config' | 'L5_error_fix' | 'L6_causality';
  title: string;
  fix: string;
  status: 'pending' | 'verified' | 'canonical' | 'deprecated';
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
  promptSnippet: string; // 可直接注入 Agent prompt 的文本
}
