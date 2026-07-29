/**
 * Goal Phase Hooks
 *
 * Goal 创建 → Plan 审批 → GoalScheduler dispatch
 */
import type { ConstraintContext } from '@dommaker/harness';
/** Goal 创建前：harness 约束检查（采样模式，减少 I/O） */
export declare function beforeGoalCreate(ctx: ConstraintContext): Promise<void>;
/** Agent dispatch 前：Iron Laws + 前置条件 */
export declare function beforeAgentDispatch(ctx: ConstraintContext & {
    hasWorktree?: boolean;
    worktreePath?: string;
}): Promise<void>;
//# sourceMappingURL=goal.hooks.d.ts.map