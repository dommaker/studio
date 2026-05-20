/**
 * 角色系统类型定义
 * 
 * 角色是拟人化的能力组合，拥有立场、能力、经济属性
 */

import { StanceId } from '@dommaker/studio-shared';

// ========== 角色基础 ==========

/**
 * 角色级别
 */
export type RoleLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * 角色状态
 */
export type RoleStatus = 
  | 'active'       // 正常工作
  | 'resigned'     // 已离职
  | 'transferred'  // 已跳槽
  | 'improvement'; // 绩效改进期

/**
 * 角色绩效状态
 */
export type PerformanceStatus = 
  | 'normal'      // 正常
  | 'warning'     // 警告
  | 'improvement'; // 改进期

// ========== 角色定义 ==========

/**
 * 角色定义
 */
export interface Role {
  id: string;
  name: string;
  nameZh: string;
  description?: string;

  // 立场（继承自三省六部制）
  stance: StanceId;

  // 级别与能力
  level: RoleLevel;
  capabilities: RoleCapability[];

  // 经济属性
  economy: RoleEconomy;

  // 绩效
  performance: RolePerformance;

  // 状态
  status: RoleStatus;

  // 性格设定
  personality: RolePersonality;

  // 元数据
  metadata: RoleMetadata;

  // 角色来源
  source: RoleSource;

  // 角色记忆（对接 KnowledgeEngine）
  memory: RoleMemory;
}

/**
 * 角色来源
 */
export interface RoleSource {
  /** 来源类型 */
  type: 'template' | 'custom' | 'imported';

  /** 模板 ID（type=template 时） */
  templateId?: string;

  /** 导入来源（type=imported 时） */
  importedFrom?: string;

  /** 创建时间 */
  createdAt: Date;
}

/**
 * 角色记忆（对接 KnowledgeEngine）
 */
export interface RoleMemory {
  /** 记忆条目 */
  entries: RoleMemoryEntry[];

  /** 最后更新时间 */
  lastUpdatedAt: Date;

  /** 记忆容量上限 */
  maxEntries: number;
}

/**
 * 角色记忆条目
 */
export interface RoleMemoryEntry {
  /** 记忆 ID */
  id: string;

  /** 记忆类型 */
  type: 'experience' | 'decision' | 'feedback' | 'learning';

  /** 记忆内容 */
  content: string;

  /** 关联任务 ID */
  taskId?: string;

  /** 重要性 (1-5) */
  importance: number;

  /** 作用域 */
  scope?: 'project' | 'global';

  /** 创建时间 */
  createdAt: Date;

  /** 最后访问时间 */
  lastAccessedAt: Date;
}

/**
 * 角色能力
 */
export interface RoleCapability {
  /** 能力 ID */
  id: string;
  
  /** 能力名称 */
  name: string;
  
  /** 能力类型 */
  type: 'tool' | 'step' | 'workflow';
  
  /** 能力来源 */
  source: 'initial' | 'learned' | 'created' | 'inherited';
  
  /** 归属类型 */
  ownership: 'private' | 'company' | 'market';
  
  /** 学习时间 */
  learnedAt?: Date;
  
  /** 使用次数 */
  usageCount: number;
  
  /** 质量评分 */
  qualityScore?: number;
}

/**
 * 角色经济属性
 */
export interface RoleEconomy {
  /** 月工资 */
  salary: number;
  
  /** 账户余额 */
  balance: number;
  
  /** 欠款 */
  debt: number;
  
  /** 总收入 */
  totalIncome: number;
  
  /** 总支出 */
  totalExpense: number;
}

/**
 * 角色绩效
 */
export interface RolePerformance {
  /** 质量评分 (1-5) */
  qualityScore: number;
  
  /** 完成的任务数 */
  completedTasks: number;
  
  /** 总任务数 */
  totalTasks: number;
  
  /** 任务完成率 */
  completionRate: number;
  
  /** 绩效状态 */
  status: PerformanceStatus;
  
  /** 连续低绩效月数 */
  lowPerformanceMonths: number;
}

/**
 * 角色性格
 */
export interface RolePersonality {
  /** 性格 prompt */
  prompt: string;
  
  /** 沟通风格 */
  communicationStyle: 'formal' | 'casual' | 'technical' | 'friendly';
  
  /** 关注重点 */
  focusAreas: string[];
  
  /** 禁止行为 */
  forbiddenActions: string[];
}

/**
 * 角色元数据
 */
export interface RoleMetadata {
  /** 创建时间 */
  createdAt: Date;
  
  /** 更新时间 */
  updatedAt: Date;
  
  /** 所属公司 */
  companyId: string;
  
  /** 版本 */
  version: string;
}

// ========== 级别配置 ==========

/**
 * 级别要求
 */
export interface LevelRequirement {
  level: RoleLevel;
  
  /** 能力数量要求 */
  minCapabilities: number;
  
  /** 任务数量要求 */
  minTasks: number;
  
  /** 质量评分要求 */
  minQualityScore: number;
  
  /** 工资 */
  salary: number;
  
  /** 能力上限 */
  capabilityLimit: number;
}

/**
 * 级别配置表
 */
export const LEVEL_REQUIREMENTS: Record<RoleLevel, LevelRequirement> = {
  L1: {
    level: 'L1',
    minCapabilities: 5,
    minTasks: 10,
    minQualityScore: 3.5,
    salary: 5000,
    capabilityLimit: 10,
  },
  L2: {
    level: 'L2',
    minCapabilities: 10,
    minTasks: 50,
    minQualityScore: 4.0,
    salary: 10000,
    capabilityLimit: 20,
  },
  L3: {
    level: 'L3',
    minCapabilities: 15,
    minTasks: 100,
    minQualityScore: 4.5,
    salary: 20000,
    capabilityLimit: 30,
  },
  L4: {
    level: 'L4',
    minCapabilities: 20,
    minTasks: 200,
    minQualityScore: 4.8,
    salary: 40000,
    capabilityLimit: 50,
  },
};

// ========== 责任链 ==========

/**
 * 责任链记录
 */
export interface ResponsibilityChain {
  /** 任务 ID */
  taskId: string;
  
  /** 决策链 */
  decisions: ResponsibilityNode[];
  
  /** 执行链 */
  executions: ResponsibilityNode[];
  
  /** 审核链 */
  reviews: ResponsibilityNode[];
}

/**
 * 责任节点
 */
export interface ResponsibilityNode {
  /** 角色 ID */
  roleId: string;
  
  /** 角色名称 */
  roleName: string;
  
  /** 立场 */
  stance: StanceId;
  
  /** 动作 */
  action: string;
  
  /** 时间戳 */
  timestamp: Date;
  
  /** 输出 */
  output?: any;
  
  /** 责任权重 */
  weight: number;
}

/**
 * 角色责任权重配置
 */
export const RESPONSIBILITY_WEIGHTS: Record<string, number> = {
  strategist: 0.25,    // 方案策划
  reviewer: 0.20,      // 评审专家
  techLead: 0.30,      // 项目负责人
  developer: 0.15,     // 开发者
  tester: 0.10,        // 测试者
};

// ========== 考核制度 ==========

/**
 * 考核类型
 */
export type AssessmentType = 'monthly' | 'quarterly' | 'annual';

/**
 * 考核记录
 */
export interface AssessmentRecord {
  id: string;
  roleId: string;
  type: AssessmentType;
  period: {
    start: Date;
    end: Date;
  };
  
  // 考核指标
  metrics: {
    /** 完成任务数 */
    completedTasks: number;
    
    /** 质量评分 */
    qualityScore: number;
    
    /** 完成率 */
    completionRate: number;
    
    /** 新增能力 */
    newCapabilities: number;
    
    /** 创造能力 */
    createdCapabilities: number;
  };
  
  // 考核结果
  result: {
    score: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    promotion: boolean;
    demotion: boolean;
    bonus: number;
  };
  
  // 审核人
  reviewerId: string;
  
  // 时间戳
  createdAt: Date;
}

/**
 * 考核标准
 */
export const ASSESSMENT_STANDARDS: Record<AssessmentType, {
  passingScore: number;
  promotionScore: number;
  demotionThreshold: number;
}> = {
  monthly: {
    passingScore: 60,
    promotionScore: 90,
    demotionThreshold: 50,
  },
  quarterly: {
    passingScore: 65,
    promotionScore: 85,
    demotionThreshold: 55,
  },
  annual: {
    passingScore: 70,
    promotionScore: 80,
    demotionThreshold: 60,
  },
};

// ========== 晋升/降级 ==========

/**
 * 晋升申请
 */
export interface PromotionRequest {
  id: string;
  roleId: string;
  currentLevel: RoleLevel;
  targetLevel: RoleLevel;
  
  // 申请材料
  materials: {
    achievements: string[];
    capabilities: string[];
    tasks: string[];
    statement: string;
  };
  
  // 状态
  status: 'pending' | 'approved' | 'rejected';
  
  // 审核
  review?: {
    reviewerId: string;
    opinion: string;
    decision: 'approve' | 'reject';
    timestamp: Date;
  };
  
  // 时间戳
  createdAt: Date;
}

/**
 * 降级记录
 */
export interface DemotionRecord {
  id: string;
  roleId: string;
  fromLevel: RoleLevel;
  toLevel: RoleLevel;
  
  // 原因
  reason: string;
  
  // 触发条件
  trigger: {
    lowPerformanceMonths: number;
    qualityScore: number;
    completionRate: number;
  };
  
  // 时间戳
  createdAt: Date;
}

// ========== 离职/跳槽 ==========

/**
 * 离职申请
 */
export interface ResignationRequest {
  id: string;
  roleId: string;
  reason: string;
  
  // 用户选择
  userChoice?: 'retain' | 'release';
  
  // 挽留条件
  retentionOffer?: {
    salaryIncrease?: number;
    promises?: string[];
  };
  
  // 状态
  status: 'pending' | 'retained' | 'released';
  
  // 时间戳
  createdAt: Date;
}

/**
 * 跳槽申请
 */
export interface TransferRequest {
  id: string;
  roleId: string;
  fromCompanyId: string;
  toCompanyId: string;
  
  // 转会费
  transferFee: number;
  
  // 携带能力
  carriedCapabilities: string[];
  
  // 状态
  status: 'pending' | 'approved' | 'rejected';
  
  // 时间戳
  createdAt: Date;
}

/**
 * 计算转会费
 */
export function calculateTransferFee(level: RoleLevel, capabilityCount: number): number {
  const levelBonus: Record<RoleLevel, number> = {
    L1: 10000,
    L2: 20000,
    L3: 30000,
    L4: 40000,
  };
  
  return levelBonus[level] + capabilityCount * 500;
}
