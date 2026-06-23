/**
 * Goal Service - Facade
 *
 * @deprecated Phase 3 LOW: Goal 驱动架构正在迁移到 WorkUnit 统一模型。
 * 本文件为 thin facade，所有方法委托给 goal-crud/goal-lifecycle/goal-review。
 * Phase 3 HIGH 将替换为 WorkUnitService，届时删除此文件。
 *
 * Goal 驱动架构核心：人定义目标和约束，LLM 生成执行计划，系统自动调度执行。
 *
 * P11-03: Split into sub-modules:
 *   goal-crud.ts — create/read/update/delete operations
 *   goal-lifecycle.ts — status transitions (pending→active→done/error)
 *   goal-review.ts — review integration (assign reviewers, process feedback)
 */

// Re-export types and standalone functions for zero breaking changes
export { parseJsonField, type GoalStep, type GoalPlanDraft, type CreateGoalInput } from './goal-crud.js';
export {
  createGoal, getGoal, listGoals, deleteGoal, generatePlan, approvePlan,
  startExecution, createGoalFromChannelDoc, getExecutableSteps,
} from './goal-crud.js';
export {
  updateStepExecution, cancelGoalExecution, retryGoalExecution,
  checkGoalCompletion, handleGoalFailed, recordGoalCompletion,
} from './goal-lifecycle.js';
export { findReviewWorktree, handleGoalSucceeded } from './goal-review.js';

import {
  createGoal as createGoalImpl,
  getGoal as getGoalImpl,
  listGoals as listGoalsImpl,
  deleteGoal as deleteGoalImpl,
  generatePlan as generatePlanImpl,
  approvePlan as approvePlanImpl,
  startExecution as startExecutionImpl,
  createGoalFromChannelDoc as createGoalFromChannelDocImpl,
  getExecutableSteps as getExecutableStepsImpl,
  type CreateGoalInput,
  type GoalPlanDraft,
} from './goal-crud.js';
import {
  updateStepExecution as updateStepExecutionImpl,
  cancelGoalExecution as cancelGoalExecutionImpl,
  retryGoalExecution as retryGoalExecutionImpl,
  checkGoalCompletion as checkGoalCompletionImpl,
} from './goal-lifecycle.js';
import type { FailureClass } from './failure-classifier.js';

// ─── Goal Service Class (thin wrapper) ───
// @deprecated Phase 3 LOW → WorkUnitService 将替代此类。见 goal.service.ts 模块注释。

export class GoalService {
  /** @deprecated → WorkUnitService.create() — Goal 创建迁移为 WorkUnit 创建 */
  async createGoal(input: CreateGoalInput): Promise<any> {
    return createGoalImpl(input);
  }

  /** @deprecated → WorkUnitService.getById() */
  async getGoal(goalId: string): Promise<any> {
    return getGoalImpl(goalId);
  }

  /** @deprecated → WorkUnitService.list() — listGoals 迁移为 WorkUnit 列表查询 */
  async listGoals(companyId: string, status?: string, failureType?: string): Promise<any[]> {
    return listGoalsImpl(companyId, status, failureType);
  }

  /** @deprecated → Analyst 直接输出 acGroups，不再需要 LLM 二次分解 */
  async generatePlan(goalId: string): Promise<GoalPlanDraft> {
    return generatePlanImpl(goalId);
  }

  /** @deprecated → Channel 流程直接创建 executing 状态，无需手动审批 */
  async approvePlan(goalId: string): Promise<void> {
    return approvePlanImpl(goalId);
  }

  /** @deprecated → Channel 流程直接创建 GoalExecution，无需手动触发 */
  async startExecution(goalId: string): Promise<any[]> {
    return startExecutionImpl(goalId);
  }

  /** @deprecated → WorkUnitService.createFromChannelDoc() — Channel 文档转 WorkUnit */
  async createGoalFromChannelDoc(input: Parameters<typeof createGoalFromChannelDocImpl>[0]) {
    return createGoalFromChannelDocImpl(input);
  }

  /** @deprecated → WorkUnitService.updateExecution() — 步骤执行状态更新 */
  async updateStepExecution(
    executionId: string,
    updates: { status?: string; output?: any; error?: string; input?: any; failureType?: FailureClass; timeoutAt?: Date },
  ): Promise<any> {
    return updateStepExecutionImpl(executionId, updates, (goalId) => this.checkGoalCompletion(goalId));
  }

  /** @deprecated → WorkUnitService.checkCompletion() */
  async checkGoalCompletion(goalId: string): Promise<void> {
    return checkGoalCompletionImpl(goalId);
  }

  /** @deprecated → WorkUnitService.getExecutableSteps() */
  async getExecutableSteps(goalId: string): Promise<any[]> {
    return getExecutableStepsImpl(goalId);
  }

  /** @deprecated → WorkUnitService.delete() */
  async deleteGoal(goalId: string): Promise<void> {
    return deleteGoalImpl(goalId);
  }

  /** @deprecated → WorkUnitService.cancelExecution() */
  async cancelGoalExecution(executionId: string): Promise<any> {
    return cancelGoalExecutionImpl(executionId, (goalId) => this.checkGoalCompletion(goalId));
  }

  /** @deprecated → WorkUnitService.retryExecution() */
  async retryGoalExecution(executionId: string): Promise<any> {
    return retryGoalExecutionImpl(executionId);
  }
}

/** @deprecated Phase 3 LOW → 使用 WorkUnitService 单例替代 */
export const goalService = new GoalService();
