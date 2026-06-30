/**
 * Goal Service - Facade
 *
 * @deprecated Pipeline（Goal 系统）已废弃，由 Agent Network（WorkUnit）替代。
 * Phase 4 将删除整个 goals/ 目录。不要新增代码到此文件。
 * 迁移进度：Phase 1 ✅（MonitorAgent/OKR 查询迁移）→ Phase 2 ✅（价值提取）→ Phase 3（本标注）→ Phase 4（删除）
 *
 * Pipeline（Goal 系统）的统一入口。Goal + GoalPlan + GoalExecution 三层模型：
 * 人定义目标和约束，LLM 生成执行计划，系统自动调度执行。
 *
 * 注意：Goal 系统与 Agent Network（WorkUnit）是独立系统，各有专属表。
 * Goal 系统操作 Goal/GoalPlan/GoalExecution 表，不操作 WorkUnit 表。
 *
 * P11-03: Split into sub-modules:
 *   goal-crud.ts — create/read/update/delete operations
 *   goal-lifecycle.ts — status transitions (pending→running→succeeded/failed)
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
import type { FailureClass } from '../shared/failure-classifier.js';

// ─── Goal Service Class ───

export class GoalService {
  async createGoal(input: CreateGoalInput): Promise<any> {
    return createGoalImpl(input);
  }

  async getGoal(goalId: string): Promise<any> {
    return getGoalImpl(goalId);
  }

  async listGoals(companyId: string, status?: string, failureType?: string): Promise<any[]> {
    return listGoalsImpl(companyId, status);
  }

  /** @deprecated Analyst 直接输出 acGroups，不再需要 LLM 二次分解 */
  async generatePlan(goalId: string): Promise<GoalPlanDraft> {
    return generatePlanImpl(goalId);
  }

  /** @deprecated Channel 流程直接创建 executing 状态，无需手动审批 */
  async approvePlan(goalId: string): Promise<void> {
    return approvePlanImpl(goalId);
  }

  /** @deprecated Channel 流程直接创建 GoalExecution，无需手动触发 */
  async startExecution(goalId: string): Promise<any[]> {
    return startExecutionImpl(goalId);
  }

  async createGoalFromChannelDoc(input: Parameters<typeof createGoalFromChannelDocImpl>[0]) {
    return createGoalFromChannelDocImpl(input);
  }

  async updateStepExecution(
    executionId: string,
    updates: { status?: string; output?: any; error?: string; input?: any; failureType?: FailureClass; timeoutAt?: Date },
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
