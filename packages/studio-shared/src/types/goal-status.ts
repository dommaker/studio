/**
 * Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束
 * C1: 状态机枚举 (2026-05-21)
 */

export type GoalStatus = 'draft' | 'planning' | 'executing' | 'succeeded' | 'failed' | 'blocked';
export type GoalPlanStatus = 'draft' | 'approved' | 'executing' | 'completed';
export type GoalExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

// ── Valid transitions ──

const GOAL_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  draft: ['planning'],
  planning: ['executing', 'draft'],
  executing: ['succeeded', 'failed', 'blocked'],
  succeeded: [],
  failed: ['executing'],                    // retry
  blocked: ['executing', 'failed', 'draft'], // fix, abandon, restart
};

const GOAL_PLAN_TRANSITIONS: Record<GoalPlanStatus, GoalPlanStatus[]> = {
  draft: ['approved', 'draft'],
  approved: ['executing', 'draft'],
  executing: ['completed'],
  completed: [],
};

const GOAL_EXECUTION_TRANSITIONS: Record<GoalExecutionStatus, GoalExecutionStatus[]> = {
  pending: ['running'],
  running: ['succeeded', 'failed', 'pending'],  // pending = recovery re-queue
  succeeded: ['pending', 'running'],             // re-review fix cycle
  failed: ['pending', 'running'],                // retry
};

// ── Validation ──

export function isValidGoalStatus(s: string): s is GoalStatus {
  return ['draft', 'planning', 'executing', 'succeeded', 'failed', 'blocked'].includes(s);
}

export function isValidGoalPlanStatus(s: string): s is GoalPlanStatus {
  return ['draft', 'approved', 'executing', 'completed'].includes(s);
}

export function isValidGoalExecutionStatus(s: string): s is GoalExecutionStatus {
  return ['pending', 'running', 'succeeded', 'failed'].includes(s);
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionGoalPlan(from: GoalPlanStatus, to: GoalPlanStatus): boolean {
  return GOAL_PLAN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionGoalExecution(from: GoalExecutionStatus, to: GoalExecutionStatus): boolean {
  return GOAL_EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Assert valid transition, throws on invalid
 */
export function assertGoalTransition(from: GoalStatus, to: GoalStatus, context?: string): void {
  if (!canTransitionGoal(from, to)) {
    throw new Error(`Invalid Goal transition: ${from} → ${to}${context ? ` (${context})` : ''}`);
  }
}

export function assertGoalExecutionTransition(from: GoalExecutionStatus, to: GoalExecutionStatus, context?: string): void {
  if (!canTransitionGoalExecution(from, to)) {
    throw new Error(`Invalid GoalExecution transition: ${from} → ${to}${context ? ` (${context})` : ''}`);
  }
}
