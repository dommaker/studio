/**
 * Goal Phase Hooks
 *
 * Goal 创建 → Plan 审批 → GoalScheduler dispatch
 */

import { checkBeforeExecution } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';
import { safeCallHook } from './config';
import { sampledCheck } from '../runtime/cache';

/** Goal 创建前：harness 约束检查（采样模式，减少 I/O） */
export async function beforeGoalCreate(ctx: ConstraintContext): Promise<void> {
  await safeCallHook('beforeGoalCreate', async () => {
    const key = `goal_create:${ctx.projectPath || 'default'}`;
    await sampledCheck(key, async () => {
      await checkBeforeExecution({
        operation: 'goal_creation',
        taskDescription: ctx.taskDescription,
        projectPath: ctx.projectPath,
      });
      return true;
    });
  });
}

/** Agent dispatch 前：Iron Laws + 前置条件 */
export async function beforeAgentDispatch(ctx: ConstraintContext & {
  hasWorktree?: boolean;
  worktreePath?: string;
}): Promise<void> {
  await safeCallHook('beforeAgentDispatch', async () => {
    await checkBeforeExecution({
      operation: 'code_implementation',
      taskDescription: ctx.taskDescription,
      projectPath: ctx.projectPath,
      hasWorktree: ctx.hasWorktree,
      worktreePath: ctx.worktreePath,
    });
  });
}
