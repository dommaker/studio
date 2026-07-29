/**
 * Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束
 * C1: 状态机枚举 (2026-05-21)
 */
// ── Valid transitions ──
const GOAL_TRANSITIONS = {
    draft: ['planning'],
    planning: ['executing', 'draft'],
    executing: ['succeeded', 'failed', 'blocked'],
    succeeded: [],
    failed: ['executing'], // retry
    blocked: ['executing', 'failed', 'draft'], // fix, abandon, restart
};
const GOAL_PLAN_TRANSITIONS = {
    draft: ['approved', 'draft'],
    approved: ['executing', 'draft'],
    executing: ['completed'],
    completed: [],
};
const GOAL_EXECUTION_TRANSITIONS = {
    pending: ['running'],
    running: ['succeeded', 'failed', 'pending'], // pending = recovery re-queue
    succeeded: ['pending', 'running'], // re-review fix cycle
    failed: ['pending', 'running'], // retry
};
// ── Validation ──
export function isValidGoalStatus(s) {
    return ['draft', 'planning', 'executing', 'succeeded', 'failed', 'blocked'].includes(s);
}
export function isValidGoalPlanStatus(s) {
    return ['draft', 'approved', 'executing', 'completed'].includes(s);
}
export function isValidGoalExecutionStatus(s) {
    return ['pending', 'running', 'succeeded', 'failed'].includes(s);
}
export function canTransitionGoal(from, to) {
    return GOAL_TRANSITIONS[from]?.includes(to) ?? false;
}
export function canTransitionGoalPlan(from, to) {
    return GOAL_PLAN_TRANSITIONS[from]?.includes(to) ?? false;
}
export function canTransitionGoalExecution(from, to) {
    return GOAL_EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}
/**
 * Assert valid transition, throws on invalid
 */
export function assertGoalTransition(from, to, context) {
    if (!canTransitionGoal(from, to)) {
        throw new Error(`Invalid Goal transition: ${from} → ${to}${context ? ` (${context})` : ''}`);
    }
}
export function assertGoalExecutionTransition(from, to, context) {
    if (!canTransitionGoalExecution(from, to)) {
        throw new Error(`Invalid GoalExecution transition: ${from} → ${to}${context ? ` (${context})` : ''}`);
    }
}
//# sourceMappingURL=goal-status.js.map