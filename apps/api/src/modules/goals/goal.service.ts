/**
 * Goal Service - Facade
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

// ─── Goal Service Class (thin wrapper) ───

export class GoalService {
  async createGoal(input: CreateGoalInput): Promise<any> {
    return createGoalImpl(input);
  }

  async getGoal(goalId: string): Promise<any> {
    return getGoalImpl(goalId);
  }

  async listGoals(companyId: string, status?: string): Promise<any[]> {
    return listGoalsImpl(companyId, status);
  }

  async generatePlan(goalId: string): Promise<GoalPlanDraft> {
    return generatePlanImpl(goalId);
  }

  async approvePlan(goalId: string): Promise<void> {
    return approvePlanImpl(goalId);
  }

  async startExecution(goalId: string): Promise<any[]> {
    return startExecutionImpl(goalId);
  }

  async createGoalFromChannelDoc(input: Parameters<typeof createGoalFromChannelDocImpl>[0]) {
    return createGoalFromChannelDocImpl(input);
  }

  async updateStepExecution(
    executionId: string,
    updates: { status?: string; output?: any; error?: string; input?: any },
  ): Promise<any> {
    return updateStepExecutionImpl(executionId, updates, (goalId) => this.checkGoalCompletion(goalId));
  }

  async checkGoalCompletion(goalId: string): Promise<void> {
    return checkGoalCompletionImpl(goalId);
  }

  async getExecutableSteps(goalId: string): Promise<any[]> {
    return getExecutableStepsImpl(goalId);
  }

  async deleteGoal(goalId: string): Promise<void> {
    return deleteGoalImpl(goalId);
  }

  async cancelGoalExecution(executionId: string): Promise<any> {
    return cancelGoalExecutionImpl(executionId, (goalId) => this.checkGoalCompletion(goalId));
  }

  async retryGoalExecution(executionId: string): Promise<any> {
    return retryGoalExecutionImpl(executionId);
  }
}

export const goalService = new GoalService();
