/**
 * 责任链模型 - 类型定义
 *
 * 统一 Stage → Role → Tools → Constraint 映射规则
 *
 * @see docs/responsibility-chain-design.md
 */
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
export type ChangeType = 'database' | 'authentication' | 'api_contract' | 'security' | 'finance' | 'performance' | 'breaking_change' | 'config' | 'ui' | 'documentation' | 'refactor' | 'feature' | 'bugfix';
/**
 * 责任链配置（单一数据源）
 *
 * 定义每个阶段的责任角色顺序
 * 按重要性排序：越靠前越关键
 */
export declare const RESPONSIBILITY_CHAIN: Record<Stage, Role[]>;
/**
 * 变更类型 → 专家角色补充
 *
 * 某些变更类型需要特定专家参与
 * 这些角色会追加到基础责任链
 */
export declare const CHANGE_TYPE_EXPERTS: Record<ChangeType, Role[]>;
/**
 * 约束级别 → 责任链截取深度
 */
export declare const CONSTRAINT_DEPTH: Record<ConstraintLevel, number>;
/**
 * 阶段 → 可用 Tools
 *
 * 每个 Stage 可以使用的 Tools 目录
 */
export declare const STAGE_TOOLS: Record<Stage, string[]>;
/**
 * 阶段名称
 */
export declare const STAGE_NAMES: Record<Stage, string>;
/**
 * 角色名称
 */
export declare const ROLE_NAMES: Record<Role, string>;
/**
 * 角色描述
 */
export declare const ROLE_DESCRIPTIONS: Record<Role, string>;
/**
 * 角色配置（自动推导）
 */
export interface RoleDerivedConfig {
    role: Role;
    stages: Stage[];
    tools: string[];
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
}
/**
 * 决策审批参与者
 *
 * @param stage 开发阶段
 * @param constraintLevel 约束级别
 * @param changeTypes 变更类型列表
 * @returns 需要参与审批的角色列表
 */
export declare function decideParticipants(stage: Stage, constraintLevel: ConstraintLevel, changeTypes: ChangeType[]): Role[];
/**
 * 判断角色是否可以执行某个阶段
 *
 * @param role 角色
 * @param stage 开发阶段
 * @returns 是否有责任
 */
export declare function canRoleExecuteStage(role: Role, stage: Stage): boolean;
/**
 * 获取角色在某个阶段的责任深度
 *
 * @param role 角色
 * @param stage 开发阶段
 * @returns 责任深度（0=首要，1=次要，-1=无责任）
 */
export declare function getRoleDepthInStage(role: Role, stage: Stage): number;
/**
 * 判断 Tools 是否适用于某个阶段
 *
 * @param toolPath Tool 路径
 * @param stage 开发阶段
 * @returns 是否可用
 */
export declare function isToolAllowedForStage(toolPath: string, stage: Stage): boolean;
/**
 * 推导角色配置
 *
 * 根据责任链自动推导：
 * - 可参与的阶段
 * - 可使用的 Tools
 */
export declare function deriveRoleConfig(role: Role): RoleDerivedConfig;
/**
 * 构建 UI 分类数据
 *
 * 从配置自动聚合，不硬编码
 */
export declare function buildUICategories(): UICategory[];
//# sourceMappingURL=responsibility-chain.d.ts.map