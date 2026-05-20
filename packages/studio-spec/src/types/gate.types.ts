/**
 * 门禁类型定义
 * 
 * SP-003: GateChecker 整合
 */

import { ChangeLevel } from './change.types.js';

/**
 * 检查点类型
 */
export type CheckpointType =
  // 业务检查（GateChecker 实现）
  | 'spec_format' // Spec 格式正确
  | 'test_coverage' // 测试覆盖变更
  | 'api_schema' // API Schema 有效
  | 'architecture' // 架构依赖检查
  | 'ac_complete' // AC 完整覆盖
  // Harness 通用检查
  | 'file_exists' // 文件存在
  | 'file_contains' // 文件包含内容
  | 'command_success' // 命令执行成功
  | 'output_matches'; // 输出匹配正则

/**
 * Harness 检查配置
 */
export interface HarnessCheckConfig {
  /** 文件路径 */
  path?: string;
  /** 预期内容 */
  content?: string;
  /** 命令 */
  command?: string;
  /** 正则表达式 */
  pattern?: string;
  /** 工作目录 */
  workdir?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 检查配置（统一）
 */
export interface CheckConfig {
  /** 检查类型 */
  type: CheckpointType;
  /** Harness 配置（用于通用检查） */
  harness?: HarnessCheckConfig;
}

/**
 * 检查点结果
 */
export interface CheckResult {
  type: CheckpointType;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * 门禁验证输入
 */
export interface ValidateChangeInput {
  changeId: string;
  checkpoints?: CheckpointType[]; // 可选，默认根据级别
}

/**
 * 门禁验证结果
 */
export interface ValidateChangeResult {
  changeId: string;
  level: ChangeLevel;
  passed: boolean;
  checks: CheckResult[];
  summary: string;
  canProceed: boolean; // 是否可以继续审批流程
}

/**
 * 门禁策略
 */
export interface GatePolicy {
  level: ChangeLevel;
  checkpoints: CheckpointType[];
  autoApprove: boolean;
  requiresHumanReview: boolean;
  description: string;
}

/**
 * 门禁策略配置（分级）
 */
export const GATE_POLICIES: Record<ChangeLevel, GatePolicy> = {
  L1: {
    level: 'L1',
    checkpoints: [],
    autoApprove: true,
    requiresHumanReview: false,
    description: 'L1 微小变更无需门禁',
  },
  L2: {
    level: 'L2',
    checkpoints: ['spec_format', 'test_coverage'],
    autoApprove: true,
    requiresHumanReview: false,
    description: 'L2 小变更自动门禁验证',
  },
  L3: {
    level: 'L3',
    checkpoints: ['spec_format', 'test_coverage', 'api_schema', 'ac_complete'],
    autoApprove: false,
    requiresHumanReview: true,
    description: 'L3 中变更门禁 + 单人审批',
  },
  L4: {
    level: 'L4',
    checkpoints: ['spec_format', 'test_coverage', 'api_schema', 'architecture', 'ac_complete'],
    autoApprove: false,
    requiresHumanReview: true,
    description: 'L4 大变更完整门禁 + 评审',
  },
};

/**
 * Harness 检查类型映射
 */
export const HARNESS_CHECK_TYPES: Set<CheckpointType> = new Set([
  'file_exists',
  'file_contains',
  'command_success',
  'output_matches',
]);

/**
 * 判断是否是 Harness 检查
 */
export function isHarnessCheck(type: CheckpointType): boolean {
  return HARNESS_CHECK_TYPES.has(type);
}