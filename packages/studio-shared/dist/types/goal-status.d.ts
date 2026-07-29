/**
 * Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束
 * C1: 状态机枚举 (2026-05-21)
 */
export type GoalStatus = 'draft' | 'planning' | 'executing' | 'succeeded' | 'failed' | 'blocked';
export type GoalPlanStatus = 'draft' | 'approved' | 'executing' | 'completed';
export type GoalExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export declare function isValidGoalStatus(s: string): s is GoalStatus;
export declare function isValidGoalPlanStatus(s: string): s is GoalPlanStatus;
export declare function isValidGoalExecutionStatus(s: string): s is GoalExecutionStatus;
export declare function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean;
export declare function canTransitionGoalPlan(from: GoalPlanStatus, to: GoalPlanStatus): boolean;
export declare function canTransitionGoalExecution(from: GoalExecutionStatus, to: GoalExecutionStatus): boolean;
/**
 * Assert valid transition, throws on invalid
 */
export declare function assertGoalTransition(from: GoalStatus, to: GoalStatus, context?: string): void;
export declare function assertGoalExecutionTransition(from: GoalExecutionStatus, to: GoalExecutionStatus, context?: string): void;
//# sourceMappingURL=goal-status.d.ts.map