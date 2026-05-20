/**
 * Meeting Phase Hooks
 *
 * 会议创建 → 讨论 → 决策 → RequirementsDoc 生成
 */

import { checkBeforeExecution, checkConstraints, ConstraintViolationError } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';

/** 会议决策完成后：质量检查（Iron Laws，S4 修复后阻断违规） */
export async function afterMeetingDecision(ctx: ConstraintContext): Promise<void> {
  await checkBeforeExecution({
    operation: 'design_request',
    taskDescription: ctx.taskDescription,
    projectPath: ctx.projectPath,
  });
}

/** RequirementsDoc 生成后：验证文档质量 + 约束检查 */
export async function afterRequirementsDoc(ctx: ConstraintContext): Promise<void> {
  const result = await checkConstraints({
    operation: 'file_modification',
    taskDescription: ctx.taskDescription,
    projectPath: ctx.projectPath,
  });
  if (!result.passed) {
    const errors = result.ironLaws.filter(r => !r.satisfied);
    if (errors.length > 0) {
      throw new ConstraintViolationError(errors[0]);
    }
  }
}
