/**
 * Goal ↔ WorkUnit 状态映射工具
 *
 * 供 Phase 2/3 消费方迁移使用。
 * 来源：goal-to-workunit-migration.md §1 状态映射表
 */

/** Goal.status → WorkUnit.status */
export const GOAL_TO_WORKUNIT_STATUS: Record<string, string> = {
  draft: 'unassigned',
  planning: 'unassigned',
  executing: 'active',
  succeeded: 'done',
  failed: 'closed',
  blocked: 'blocked',
};

/** GoalExecution.status → WorkUnit.status */
export const EXECUTION_TO_WORKUNIT_STATUS: Record<string, string> = {
  pending: 'unassigned',
  running: 'active',
  succeeded: 'done',
  failed: 'closed',
};

/** WorkUnit.status → Goal.status (反向，用于过渡期兼容查询) */
export const WORKUNIT_TO_GOAL_STATUS: Record<string, string> = {
  unassigned: 'draft',
  active: 'executing',
  in_review: 'executing',
  done: 'succeeded',
  closed: 'failed',
  blocked: 'blocked',
};

/**
 * 将 Goal 状态过滤条件转换为 WorkUnit 状态过滤条件。
 * 用于迁移 Prisma 查询时的状态 IN 条件。
 *
 * @example
 * // Before: where: { status: { in: ['succeeded', 'failed'] } }
 * // After:  where: { status: { in: mapGoalStatuses(['succeeded', 'failed']) } }
 */
export function mapGoalStatuses(goalStatuses: string[]): string[] {
  return goalStatuses
    .map(s => GOAL_TO_WORKUNIT_STATUS[s])
    .filter(Boolean);
}

/**
 * 将 GoalExecution 状态过滤条件转换为 WorkUnit 状态过滤条件。
 */
export function mapExecutionStatuses(execStatuses: string[]): string[] {
  return execStatuses
    .map(s => EXECUTION_TO_WORKUNIT_STATUS[s])
    .filter(Boolean);
}

/**
 * 判断 WorkUnit 是否处于终态（等价于 Goal 的 succeeded/failed）。
 */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'closed';
}

/**
 * 判断 WorkUnit 是否处于活跃状态（等价于 GoalExecution 的 running）。
 */
export function isActiveStatus(status: string): boolean {
  return status === 'active' || status === 'in_review';
}
