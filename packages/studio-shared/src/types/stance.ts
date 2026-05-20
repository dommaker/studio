/**
 * 立场系统类型定义
 * 
 * 三省六部制核心智慧：让每个环节的参与者只站在自己的角度往深了去思考
 */

// ========== 立场类型 ==========

/**
 * 立场分类
 */
export type StanceCategory = 'decision' | 'execution' | 'professional';

/**
 * 立场定义
 */
export interface Stance {
  id: string;
  name: string;
  nameZh: string;
  category: StanceCategory;
  description: string;
  
  /** 立场 prompt 模板 */
  prompt: string;
  
  /** 禁止行为 */
  forbiddenActions: string[];
  
  /** 思考重点 */
  focusAreas: string[];
  
  /** 典型问题 */
  typicalQuestions: string[];
  
  /** 适用角色 */
  applicableRoles: string[];
  
  /** 元数据 */
  metadata?: {
    createdAt: Date;
    updatedAt: Date;
    version: string;
  };
}

// ========== 九种立场 ==========

/**
 * 决策类立场
 */
export const DECISION_STANCES = ['critic', 'supporter', 'decider'] as const;

/**
 * 执行类立场
 */
export const EXECUTION_STANCES = ['planner', 'executor', 'tester'] as const;

/**
 * 专业类立场
 */
export const PROFESSIONAL_STANCES = ['architect', 'security', 'performance', 'auditor', 'designer', 'product'] as const;

/**
 * 所有立场 ID
 */
export type StanceId = 
  | typeof DECISION_STANCES[number]
  | typeof EXECUTION_STANCES[number]
  | typeof PROFESSIONAL_STANCES[number];

// ========== 立场继承 ==========

/**
 * 立场继承优先级
 * 
 * 1. 步骤显式声明 stance → 覆盖模式（罕见）
 * 2. 角色主立场 → 默认模式（推荐）
 * 3. 系统默认 → executor 立场
 */
export interface StanceInheritance {
  /** 立场来源 */
  source: 'explicit' | 'role' | 'default';
  
  /** 立场 ID */
  stanceId: StanceId;
  
  /** 来源角色（如果是角色继承） */
  roleId?: string;
  
  /** 步骤 ID（如果是显式声明） */
  stepId?: string;
}

/**
 * 立场注入配置
 */
export interface StanceInjectionConfig {
  /** 是否启用立场注入 */
  enabled: boolean;
  
  /** 立场继承 */
  inheritance: StanceInheritance;
  
  /** 额外的 prompt 前缀 */
  additionalPrompt?: string;
  
  /** 覆盖禁止行为 */
  overrideForbiddenActions?: string[];
}

// ========== 立场审核 ==========

/**
 * 立场审核类型
 */
export type StanceReviewType = 
  | 'single'    // 单立场审核
  | 'parallel'  // 并行多立场审核
  | 'sequential'; // 顺序多立场审核

/**
 * 立场审核配置
 */
export interface StanceReviewConfig {
  /** 审核类型 */
  type: StanceReviewType;
  
  /** 参与立场 */
  stances: StanceId[];
  
  /** 汇聚方式 */
  aggregation: 'consensus' | 'majority' | 'weighted' | 'decider';
  
  /** 决策者（用于 decider 模式） */
  decider?: string;
  
  /** 权重配置（用于 weighted 模式） */
  weights?: Record<StanceId, number>;
  
  /** 超时配置 */
  timeout?: number;
}

/**
 * 立场审核结果
 */
export interface StanceReviewResult {
  /** 审核配置 */
  config: StanceReviewConfig;
  
  /** 各立场意见 */
  opinions: StanceOpinion[];
  
  /** 最终决策 */
  decision: 'approved' | 'rejected' | 'changes_requested';
  
  /** 决策理由 */
  reason: string;
  
  /** 时间戳 */
  timestamp: Date;
}

/**
 * 单立场意见
 */
export interface StanceOpinion {
  stanceId: StanceId;
  roleId: string;
  
  /** 意见：赞成/反对/需要修改 */
  verdict: 'approve' | 'reject' | 'request_changes';
  
  /** 详细意见 */
  opinion: string;
  
  /** 发现的问题 */
  issues?: StanceIssue[];
  
  /** 建议改进 */
  suggestions?: string[];
  
  /** 权重（用于加权汇总） */
  weight?: number;
  
  /** 时间戳 */
  timestamp: Date;
}

/**
 * 立场发现的问题
 */
export interface StanceIssue {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  category: string;
  description: string;
  location?: string;
  suggestion?: string;
}

// ========== 默认立场配置 ==========

/**
 * 系统默认立场
 */
export const DEFAULT_STANCE: StanceId = 'executor';

/**
 * 立场 prompt 模板变量
 */
export interface StancePromptVariables {
  /** 任务描述 */
  task?: string;
  
  /** 输入内容 */
  input?: string;
  
  /** 上下文 */
  context?: string;
  
  /** 其他立场意见 */
  otherOpinions?: StanceOpinion[];
}
