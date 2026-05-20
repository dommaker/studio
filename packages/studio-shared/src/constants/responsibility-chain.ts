/**
 * 责任链模型 - 类型定义
 * 
 * 统一 Stage → Role → Tools → Constraint 映射规则
 * 
 * @see docs/responsibility-chain-design.md
 */

// ========== 基础枚举 ==========

/**
 * 开发阶段
 */
export type Stage = 'plan' | 'develop' | 'verify' | 'deploy' | 'fix' | 'govern';

/**
 * 责任角色
 */
export type Role = 'architect' | 'tech-lead' | 'developer' | 'qa' | 'pm' | 'ceo';

/**
 * 约束级别
 */
export type ConstraintLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * 变更类型
 */
export type ChangeType =
  | 'database'
  | 'authentication'
  | 'api_contract'
  | 'security'
  | 'finance'
  | 'performance'
  | 'breaking_change'
  | 'config'
  | 'ui'
  | 'documentation'
  | 'refactor'
  | 'feature'
  | 'bugfix';

// ========== 配置常量 ==========

/**
 * 责任链配置（单一数据源）
 * 
 * 定义每个阶段的责任角色顺序
 * 按重要性排序：越靠前越关键
 */
export const RESPONSIBILITY_CHAIN: Record<Stage, Role[]> = {
  plan: ['architect', 'pm', 'tech-lead'],
  develop: ['tech-lead', 'developer'],
  verify: ['qa', 'tech-lead'],
  deploy: ['tech-lead', 'pm'],
  fix: ['tech-lead', 'developer'],
  govern: ['architect', 'tech-lead', 'pm', 'ceo'],
};

/**
 * 变更类型 → 专家角色补充
 * 
 * 某些变更类型需要特定专家参与
 * 这些角色会追加到基础责任链
 */
export const CHANGE_TYPE_EXPERTS: Record<ChangeType, Role[]> = {
  // 高风险变更：需要架构师
  database: ['architect'],
  authentication: ['architect'],
  api_contract: ['architect'],
  security: ['architect', 'tech-lead'],
  performance: ['architect'],

  // 业务变更：需要管理层
  finance: ['pm', 'ceo'],
  breaking_change: ['architect', 'pm'],

  // 低风险变更：无需补充
  config: [],
  ui: [],
  documentation: [],
  refactor: [],
  feature: [],
  bugfix: [],
};

/**
 * 约束级别 → 责任链截取深度
 */
export const CONSTRAINT_DEPTH: Record<ConstraintLevel, number> = {
  L1: 0,   // 自动批准，不触发责任链
  L2: 1,   // 首个责任角色
  L3: 2,   // 前两个责任角色
  L4: -1,  // -1 表示全部（完整责任链）
};

/**
 * 阶段 → 可用 Tools
 * 
 * 每个 Stage 可以使用的 Tools 目录
 */
export const STAGE_TOOLS: Record<Stage, string[]> = {
  plan: [
    'analysis/*',
    'design/*',
    'planning/*',
    'backlog/*',
    'project/*',
  ],

  develop: [
    'development/*',
  ],

  verify: [
    'verification/*',
    'quality/*',
    'test/*',
    'review/*',
  ],

  deploy: [
    'deploy/*',
  ],

  fix: [
    'bugfix/*',
    'patch/*',
  ],

  govern: [
    'governance/*',
    'constraint/*',
    'evolution/*',
  ],
};

/**
 * 阶段 → Workflow 映射
 * 
 * 每个阶段可用的 Workflow
 */
export const STAGE_WORKFLOWS: Record<Stage, string[]> = {
  plan: ['wf-planning', 'wf-architecture-review', 'wf-spec-review'],
  develop: ['wf-dev', 'wf-iterate', 'wf-backend', 'wf-frontend'],
  verify: ['wf-test', 'wf-review', 'wf-e2e-test'],
  deploy: ['wf-release', 'wf-deploy'],
  fix: ['wf-bugfix', 'wf-patch'],
  govern: ['wf-evolution', 'wf-audit', 'wf-constraint'],
};

/**
 * 阶段名称
 */
export const STAGE_NAMES: Record<Stage, string> = {
  plan: '规划',
  develop: '开发',
  verify: '验证',
  deploy: '部署',
  fix: '修复',
  govern: '治理',
};

/**
 * 角色名称
 */
export const ROLE_NAMES: Record<Role, string> = {
  architect: '架构师',
  'tech-lead': '技术负责人',
  developer: '开发工程师',
  qa: '测试工程师',
  pm: '产品经理',
  ceo: '决策者',
};

/**
 * 角色描述
 */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  architect: '技术架构设计、技术选型决策',
  'tech-lead': '技术方案把关、代码审查、任务分配',
  developer: '代码实现、功能开发、Bug修复',
  qa: '质量保障、测试验证、验收把关',
  pm: '需求管理、优先级决策、产品规划',
  ceo: '高风险决策、战略审批',
};

// ========== 推导接口 ==========

/**
 * 角色配置（自动推导）
 */
export interface RoleDerivedConfig {
  role: Role;

  // 自动推导
  stages: Stage[];
  workflows: string[];
  tools: string[];

  // 静态配置
  name: string;
  description: string;
}

/**
 * UI 分类数据
 */
export interface UICategory {
  id: Stage;
  name: string;
  description: string;
  tools: string[];
  workflows: string[];
}

// ========== 核心决策函数 ==========

// ========== 核心决策函数 ==========

/**
 * 决策审批参与者
 * 
 * @param stage 开发阶段
 * @param constraintLevel 约束级别
 * @param changeTypes 变更类型列表
 * @returns 需要参与审批的角色列表
 */
export function decideParticipants(
  stage: Stage,
  constraintLevel: ConstraintLevel,
  changeTypes: ChangeType[]
): Role[] {
  // 1. L1 特殊处理：自动批准
  if (constraintLevel === 'L1') {
    return [];
  }

  // 2. 获取阶段责任链
  const chain = RESPONSIBILITY_CHAIN[stage] || [];

  // 3. 根据约束级别决定截取深度
  const depth = CONSTRAINT_DEPTH[constraintLevel];
  const baseRoles = depth === -1 ? chain : chain.slice(0, depth);

  // 4. 补充变更类型专家
  const expertRoles = changeTypes.flatMap(ct => CHANGE_TYPE_EXPERTS[ct] || []);

  // 5. 合并去重（保持顺序）
  const allRoles: Role[] = [...baseRoles];
  for (const role of expertRoles) {
    if (!allRoles.includes(role)) {
      allRoles.push(role);
    }
  }

  return allRoles;
}

/**
 * 判断角色是否可以执行某个阶段
 * 
 * @param role 角色
 * @param stage 开发阶段
 * @returns 是否有责任
 */
export function canRoleExecuteStage(role: Role, stage: Stage): boolean {
  return RESPONSIBILITY_CHAIN[stage]?.includes(role) ?? false;
}

/**
 * 获取角色在某个阶段的责任深度
 * 
 * @param role 角色
 * @param stage 开发阶段
 * @returns 责任深度（0=首要，1=次要，-1=无责任）
 */
export function getRoleDepthInStage(role: Role, stage: Stage): number {
  const chain = RESPONSIBILITY_CHAIN[stage] || [];
  const index = chain.indexOf(role);
  return index === -1 ? -1 : index;
}

/**
 * 判断 Tools 是否适用于某个阶段
 * 
 * @param toolPath Tool 路径
 * @param stage 开发阶段
 * @returns 是否可用
 */
export function isToolAllowedForStage(toolPath: string, stage: Stage): boolean {
  const allowedPatterns = STAGE_TOOLS[stage] || [];

  for (const pattern of allowedPatterns) {
    if (pattern.endsWith('*')) {
      // 通配符匹配
      const prefix = pattern.slice(0, -1);
      if (toolPath.startsWith(prefix)) return true;
    } else {
      // 精确匹配
      if (toolPath === pattern) return true;
    }
  }

  return false;
}

/**
 * 获取角色可用的 Workflow 列表
 * 
 * @param role 角色
 * @returns 可用的 Workflow ID 列表
 */
export function getRoleWorkflows(role: Role): string[] {
  const workflows: string[] = [];

  // 遍历所有阶段，找出角色有责任的阶段
  for (const stage of Object.keys(RESPONSIBILITY_CHAIN) as Stage[]) {
    if (canRoleExecuteStage(role, stage)) {
      workflows.push(...STAGE_WORKFLOWS[stage]);
    }
  }

  return [...new Set(workflows)]; // 去重
}

/**
 * 推导角色配置
 * 
 * 根据责任链自动推导：
 * - 可参与的阶段
 * - 可执行的 Workflow
 * - 可使用的 Tools
 */
export function deriveRoleConfig(role: Role): RoleDerivedConfig {
  // 1. 找出有责任的阶段
  const stages: Stage[] = [];
  for (const [stage, chain] of Object.entries(RESPONSIBILITY_CHAIN)) {
    if (chain.includes(role)) {
      stages.push(stage as Stage);
    }
  }

  // 2. 推导可用的 Workflow
  const workflows = getRoleWorkflows(role);

  // 3. 推导可用的 Tools
  const tools = stages.flatMap(s => STAGE_TOOLS[s]);
  const uniqueTools = [...new Set(tools)];

  return {
    role,
    stages,
    workflows,
    tools: uniqueTools,
    name: ROLE_NAMES[role] || role,
    description: ROLE_DESCRIPTIONS[role] || '',
  };
}

/**
 * 构建 UI 分类数据
 * 
 * 从配置自动聚合，不硬编码
 */
export function buildUICategories(): UICategory[] {
  const categories: UICategory[] = [];

  for (const [stage, _] of Object.entries(RESPONSIBILITY_CHAIN)) {
    categories.push({
      id: stage as Stage,
      name: STAGE_NAMES[stage as Stage],
      description: '', // 从 stage-definitions.ts 获取
      tools: STAGE_TOOLS[stage as Stage],
      workflows: STAGE_WORKFLOWS[stage as Stage],
    });
  }

  return categories;
}