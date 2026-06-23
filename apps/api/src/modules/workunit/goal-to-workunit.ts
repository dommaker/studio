/**
 * Goal → WorkUnit 转换工具
 *
 * 将 Goal + GoalPlan + GoalExecution 三层结构转换为 WorkUnit 树。
 * 用于渐进迁移阶段，不双写。
 *
 * 迁移计划: studio/docs/plans/goal-to-workunit-migration.md §1
 */

import type { Goal, GoalPlan, GoalExecution } from '@prisma/client';
import type { CreateWorkUnitInput, WorkUnitMetadata } from './workunit.service.js';

// ─── 状态映射 ───

const GOAL_STATUS_MAP: Record<string, string> = {
  draft: 'unassigned',
  planning: 'unassigned',    // planning 无对应，转为 unassigned
  executing: 'active',
  succeeded: 'done',
  failed: 'closed',
  blocked: 'blocked',
};

const EXECUTION_STATUS_MAP: Record<string, string> = {
  pending: 'unassigned',
  running: 'active',
  succeeded: 'done',
  failed: 'closed',
};

// ─── 类型定义 ───

interface GoalWithRelations extends Goal {
  GoalPlan?: (GoalPlan & {
    GoalExecution?: GoalExecution[];
  })[];
  GoalExecution?: GoalExecution[];
}

export interface WorkUnitTree {
  parent: CreateWorkUnitInput;
  children: CreateWorkUnitInput[];
}

// ─── 转换函数 ───

/**
 * 将 Goal 转换为 WorkUnit（父节点）。
 * Goal.title → WorkUnit.scope，其余字段降级到 metadata。
 */
export function goalToWorkUnit(goal: Goal): CreateWorkUnitInput {
  const metadata: WorkUnitMetadata = {
    priority: goal.priority as WorkUnitMetadata['priority'],
    createdBy: goal.createdBy ?? undefined,
    description: goal.description,
    constraints: goal.constraints ?? undefined,
    context: goal.context ?? undefined,
  };

  return {
    type: 'task',
    scope: goal.title,
    status: GOAL_STATUS_MAP[goal.status] ?? 'unassigned',
    metadata,
  };
}

/**
 * 将 GoalPlan 转换为子 WorkUnit 链（每个 step → 一个子 WorkUnit）。
 * GoalPlan.steps JSON 解析为 GoalStep[]，每个 step 生成一个 WorkUnit。
 * dependsOn 表达线性依赖（step[i] 依赖 step[i-1]）。
 */
export function goalPlanToWorkUnits(
  plan: GoalPlan,
  parentWorkUnitId: string,
): CreateWorkUnitInput[] {
  const steps = parseSteps(plan.steps);
  if (!steps || steps.length === 0) return [];

  const metadata: WorkUnitMetadata = {
    planVersion: plan.version,
    planReasoning: plan.reasoning ?? undefined,
  };

  return steps.map((step, index) => {
    const prevId = index > 0 ? `${parentWorkUnitId}-step-${index - 1}` : undefined;
    return {
      type: 'task',
      scope: step.title || step.description || `Step ${index}`,
      parentId: parentWorkUnitId,
      dependsOn: prevId ? [prevId] : [],
      metadata: {
        ...metadata,
        description: step.description,
        input: JSON.stringify(step.input),
      },
    };
  });
}

/**
 * 将 GoalExecution 转换为 WorkUnit 更新数据。
 * 用于将执行状态同步到对应的子 WorkUnit。
 */
export function goalExecutionToUpdate(exec: GoalExecution): {
  status?: string;
  failureType?: string;
  retryCount?: number;
  timeoutAt?: Date | null;
  metadata?: WorkUnitMetadata;
} {
  const result: ReturnType<typeof goalExecutionToUpdate> = {};

  result.status = EXECUTION_STATUS_MAP[exec.status] ?? undefined;
  if (exec.failureType) result.failureType = exec.failureType;
  if (exec.retryCount > 0) result.retryCount = exec.retryCount;
  if (exec.timeoutAt) result.timeoutAt = exec.timeoutAt;

  const metadata: WorkUnitMetadata = {};
  if (exec.input) metadata.input = exec.input;
  if (exec.output) metadata.output = exec.output;
  if (exec.error) metadata.error = exec.error;
  if (Object.keys(metadata).length > 0) result.metadata = metadata;

  return result;
}

/**
 * 完整转换：Goal + Plan + Executions → WorkUnit 树。
 * 返回父 WorkUnit + 子 WorkUnit 列表。
 */
export function convertGoalToWorkUnitTree(goal: GoalWithRelations): WorkUnitTree {
  const parent = goalToWorkUnit(goal);

  // 优先用 GoalPlan 的 steps，fallback 到直接 GoalExecution
  const plan = goal.GoalPlan?.[0];
  const children: CreateWorkUnitInput[] = [];

  if (plan) {
    const planChildren = goalPlanToWorkUnits(plan, '__PARENT_ID__');
    children.push(...planChildren);

    // 将 GoalExecution 状态同步到子 WorkUnit
    const executions = plan.GoalExecution ?? goal.GoalExecution ?? [];
    for (const exec of executions) {
      const childIndex = exec.stepIndex;
      if (childIndex >= 0 && childIndex < children.length) {
        const update = goalExecutionToUpdate(exec);
        if (update.status) children[childIndex].status = update.status;
        if (update.failureType) children[childIndex].failureType = update.failureType;
        if (update.retryCount) children[childIndex].retryCount = update.retryCount;
        if (update.timeoutAt) children[childIndex].timeoutAt = update.timeoutAt;
        if (update.metadata) {
          children[childIndex].metadata = {
            ...children[childIndex].metadata,
            ...update.metadata,
          };
        }
      }
    }
  } else if (goal.GoalExecution?.length) {
    // 无 Plan，直接将 Execution 转为子 WorkUnit
    for (const exec of goal.GoalExecution) {
      const update = goalExecutionToUpdate(exec);
      children.push({
        type: 'task',
        scope: `Execution ${exec.stepIndex}`,
        parentId: '__PARENT_ID__',
        status: update.status,
        failureType: update.failureType,
        retryCount: update.retryCount,
        timeoutAt: update.timeoutAt,
        metadata: update.metadata,
      });
    }
  }

  return { parent, children };
}

// ─── 辅助函数 ───

interface GoalStepParsed {
  index: number;
  title: string;
  description: string;
  agentType: string;
  input: Record<string, unknown>;
  dependencies: number[];
  estimatedDuration: string;
}

function parseSteps(stepsJson: string): GoalStepParsed[] | null {
  try {
    const parsed = JSON.parse(stepsJson);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
