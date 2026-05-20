/**
 * Spec 变更分级类型定义
 * 
 * SP-002: Spec 变更分级流程（L1-L4）
 */

/**
 * 失败等级（与 harness FailureLevel 对齐）
 * 
 * L1: 自动处理（重试、降级）
 * L2: 需要干预（人工审核）
 * L3: 严重问题（开会讨论）
 * L4: 致命错误（回滚）
 */
export enum FailureLevel {
  L1 = 'L1',
  L2 = 'L2',
  L3 = 'L3',
  L4 = 'L4',
}

/**
 * 变更级别
 * 
 * L1: 微小变更 - typo 修正、格式调整
 * L2: 小变更 - 参数调整、配置修改
 * L3: 中变更 - API 变更、逻辑修改
 * L4: 大变更 - 架构变更、核心逻辑重写
 */
export type ChangeLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * 变更类型
 */
export type ChangeType =
  // L1 微小变更
  | 'typo_fix' // 错字修正
  | 'format_adjust' // 格式调整
  | 'comment_update' // 注释更新
  | 'metadata_sync' // 元数据同步
  // L2 小变更
  | 'param_adjust' // 参数调整
  | 'config_update' // 配置更新
  | 'test_add' // 新增测试用例
  | 'ac_reorder' // AC 顺序调整
  // L3 中变更
  | 'api_change' // API endpoint 变更
  | 'logic_update' // 业务逻辑修改
  | 'ac_change' // AC 内容修改
  | 'dependency_add' // 新增依赖
  // L4 大变更
  | 'architecture_change' // 架构变更
  | 'core_logic_rewrite' // 核心逻辑重写
  | 'dependency_remove' // 移除依赖
  | 'ac_remove' // 移除 AC
  | 'scope_change'; // 范围变更

/**
 * 变更类型分级映射
 */
export const CHANGE_TYPE_LEVELS: Record<ChangeType, ChangeLevel> = {
  // L1
  typo_fix: 'L1',
  format_adjust: 'L1',
  comment_update: 'L1',
  metadata_sync: 'L1',
  // L2
  param_adjust: 'L2',
  config_update: 'L2',
  test_add: 'L2',
  ac_reorder: 'L2',
  // L3
  api_change: 'L3',
  logic_update: 'L3',
  ac_change: 'L3',
  dependency_add: 'L3',
  // L4
  architecture_change: 'L4',
  core_logic_rewrite: 'L4',
  dependency_remove: 'L4',
  ac_remove: 'L4',
  scope_change: 'L4',
};

/**
 * 变更类型权重（用于风险评分）
 */
export const CHANGE_TYPE_WEIGHTS: Record<ChangeType, number> = {
  // L1
  typo_fix: 0,
  format_adjust: 0,
  comment_update: 0,
  metadata_sync: 0,
  // L2
  param_adjust: 1,
  config_update: 1,
  test_add: 1,
  ac_reorder: 1,
  // L3
  api_change: 2,
  logic_update: 2,
  ac_change: 2,
  dependency_add: 2,
  // L4
  architecture_change: 3,
  core_logic_rewrite: 3,
  dependency_remove: 3,
  ac_remove: 3,
  scope_change: 3,
};

/**
 * 影响区域权重（用于风险评分）
 */
export const AREA_WEIGHTS: Record<string, number> = {
  metadata: 0,
  config: 1,
  api: 2,
  acceptance_criteria: 3,
  architecture: 3,
  dependencies: 3,
};

/**
 * 变更分析输入
 */
export interface AnalyzeChangeInput {
  specId: string;
  oldVersion: SpecContent;
  newVersion: SpecContent;
}

/**
 * 变更分析结果
 */
export interface AnalyzeChangeResult {
  /** 变更级别 */
  level: ChangeLevel;
  /** 变更类型列表 */
  changeTypes: ChangeType[];
  /** 影响区域 */
  affectedAreas: string[];
  /** 风险评分（0-100） */
  riskScore: number;
  /** 推荐审批流程 */
  recommendedApproval: ApprovalProcess;
  /** 变更摘要 */
  summary: string;
  /** 详细变更列表 */
  changes: ChangeDetail[];
}

/**
 * 变更详情
 */
export interface ChangeDetail {
  type: ChangeType;
  area: string;
  description: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * 审批流程
 */
export interface ApprovalProcess {
  /** 流程类型 */
  type: 'auto' | 'gate_checker' | 'single_approval' | 'multi_approval';
  /** 所需审批人数 */
  requiredApprovers?: number;
  /** 流程描述 */
  description: string;
  /** 预计处理时间 */
  estimatedTime: string;
}

/**
 * 变更记录
 */
export interface ChangeRecord {
  id: string;
  specId: string;
  level: ChangeLevel;
  changeTypes: ChangeType[];
  summary: string;
  status: 'pending' | 'auto_approved' | 'approved' | 'rejected' | 'applied';
  submittedBy: string;
  submittedAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
  appliedAt?: Date;
  oldVersion: SpecContent;
  newVersion: SpecContent;
  /** 审批人列表（L4 多人审批） */
  approvers?: string[];
}

/**
 * 提交变更输入
 */
export interface SubmitChangeInput {
  specId: string;
  changeContent: SpecContent;
  changeNote?: string;
  submittedBy: string;
}

/**
 * 提交变更结果
 */
export interface SubmitChangeResult {
  changeId: string;
  level: ChangeLevel;
  changeTypes: ChangeType[];
  status: 'pending_approval' | 'auto_approved' | 'needs_meeting';
  approvalProcess: ApprovalProcess;
}

/**
 * 审批变更输入
 */
export interface ApproveChangeInput {
  changeId: string;
  approvedBy: string;
  approved: boolean;
  comment?: string;
}

/**
 * Spec 内容类型（从 validation.types.ts 导入）
 */
export interface SpecContent {
  metadata: {
    id: string;
    title?: string;
    status?: 'draft' | 'in_progress' | 'completed' | 'deprecated';
    created?: string;
    updated?: string;
  };
  architecture?: {
    dependencies?: string[];
    data_models?: string[];
  };
  api?: {
    endpoints?: ApiEndpoint[];
    schemas?: Record<string, SchemaDefinition>;
  };
  acceptance_criteria?: AcceptanceCriterion[];
}

export interface ApiEndpoint {
  path: string;
  method: string;
  request?: string;
  response?: string;
}

export interface SchemaDefinition {
  type: string;
  properties?: Record<string, unknown>;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  test?: string;
  passes?: boolean;
}