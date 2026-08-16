/**
 * Goal Phase Hooks
 *
 * Goal 创建 → Plan 审批 → GoalScheduler dispatch
 */

import { checkBeforeExecution, CheckCache } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';
import { runHook } from './config';

/**
 * Goal 检查采样缓存（A1：runtime/cache.ts 退役，直用 harness CheckCache）。
 * 对同一 projectPath 每 3 次执行 1 次完整检查，其余复用缓存；
 * 非采样轮缓存未命中/过期返回 defaultValueOnMiss（true = 默认通过）。
 */
const goalCheckCache = new CheckCache();

/** Goal 创建前：harness 约束检查（采样模式，减少 I/O） */
export async function beforeGoalCreate(ctx: ConstraintContext): Promise<void> {
  await runHook('beforeGoalCreate', async () => {
    await goalCheckCache.get(
      'goal_create',
      ctx.projectPath || 'default',
      async () => {
        await checkBeforeExecution({
          operation: 'goal_creation',
          taskDescription: ctx.taskDescription,
          projectPath: ctx.projectPath,
        });
        return true;
      },
      { sampleRate: 3, defaultValueOnMiss: true },
    );
  });
}

/** Agent dispatch 前：Iron Laws + 前置条件 */
export async function beforeAgentDispatch(ctx: ConstraintContext & {
  hasWorktree?: boolean;
  worktreePath?: string;
}): Promise<void> {
  await runHook('beforeAgentDispatch', async () => {
    await checkBeforeExecution({
      operation: 'code_implementation',
      taskDescription: ctx.taskDescription,
      projectPath: ctx.projectPath,
      hasWorktree: ctx.hasWorktree,
      worktreePath: ctx.worktreePath,
      hasVerificationEvidence: (ctx as any).hasVerificationEvidence,
      hasRequirement: (ctx as any).hasRequirement,
      hasSingleTask: (ctx as any).hasSingleTask,
      hasRequirementReview: (ctx as any).hasRequirementReview,
      hasExternalCapabilityVerification: (ctx as any).hasExternalCapabilityVerification,
      hasTest: (ctx as any).hasTest,
      hasTwoStageReview: (ctx as any).hasTwoStageReview,
      hasRootCauseInvestigation: (ctx as any).hasRootCauseInvestigation,
      hasFailingTest: (ctx as any).hasFailingTest,
    });
  });
}
