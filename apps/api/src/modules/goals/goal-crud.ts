/**
 * Goal CRUD — 创建/读取/更新/删除操作
 *
 * 从 goal.service.ts 提取的纯函数。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway, eventBus, type ModelTier } from '@dommaker/studio-shared';
import { skillStore } from '../skills/skill-store.js';
import { beforeGoalCreate } from '@dommaker/studio-shared/harness/hooks';
import { eventStore } from '../../core/event-store.js';
import { v4 as uuidv4 } from 'uuid';

// ─── 类型定义 ───

// SQLite JSON 字段兼容：Prisma middleware 可能不 parse，手动兜底
export function parseJsonField<T = any>(val: unknown, fallback?: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T; } catch {
      logger.warn('Failed to parse JSON field', { val: String(val).slice(0, 100) });
      return null as any;
    }
  }
  return (val as T) ?? (fallback as T);
}

export interface GoalStep {
  index: number;
  title: string;
  description: string;
  agentType: string;         // 执行此步骤的 agent 角色类型
  input: Record<string, any>; // 步骤输入（可引用前序步骤输出）
  dependencies: number[];    // 依赖的步骤索引
  estimatedDuration: string; // 预估耗时
}

export interface GoalPlanDraft {
  steps: GoalStep[];
  reasoning: string;         // LLM 的推理过程
  estimatedTotalDuration: string;
  requiredRoles: string[];   // 所需角色类型列表
}

export interface CreateGoalInput {
  title: string;
  description: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  constraints?: Record<string, any>;
  context?: Record<string, any>;
  companyId: string;
  createdBy?: string;
}

// ─── CRUD Operations ───

/**
 * 创建目标
 */
export async function createGoal(input: CreateGoalInput): Promise<any> {
  // 去重防护：同 scope WorkUnit 24h 内 closed → 拒绝
  const recentFailures = await prisma.workUnit.count({
    where: {
      scope: input.title,
      status: 'closed',
      type: 'task',
      updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (recentFailures > 0) {
    throw new Error(
      `同标题 Goal 24h 内已失败 ${recentFailures} 次。请先审查失败原因再重新提交。标题: ${input.title.slice(0, 80)}`
    );
  }

  const goal = await prisma.workUnit.create({
    data: {
      scope: input.title,
      type: 'task',
      metadata: JSON.stringify({
        description: input.description,
        priority: input.priority || 'normal',
        constraints: input.constraints || {},
        context: input.context || {},
        companyId: input.companyId,
        createdBy: input.createdBy,
      }),
      status: 'unassigned',
    },
  });

  logger.info(`[Goal] Created: ${goal.id} (${goal.scope})`);
  return goal;
}

/**
 * 获取目标详情
 */
export async function getGoal(goalId: string): Promise<any> {
  const goal = await prisma.workUnit.findUnique({
    where: { id: goalId },
    include: {
      children: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!goal) return null;
  const meta = goal.metadata ? JSON.parse(goal.metadata) : {};
  return { ...goal, title: goal.scope, description: meta.description, ...meta };
}

/**
 * 获取公司的目标列表
 */
export async function listGoals(companyId: string, status?: string, failureType?: string): Promise<any[]> {
  const where: any = {
    type: 'task',
    parentId: null,
  };
  if (status) where.status = status;
  if (failureType) where.failureType = failureType;
  return prisma.workUnit.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * 删除目标
 */
export async function deleteGoal(goalId: string): Promise<void> {
  await prisma.workUnit.delete({ where: { id: goalId } });
  logger.info(`[Goal] Deleted: ${goalId}`);
}

/**
 * 用 LLM 生成执行计划
 */
export async function generatePlan(goalId: string): Promise<GoalPlanDraft> {
  const goal = await prisma.workUnit.findUnique({ where: { id: goalId } });
  if (!goal) throw new Error('Goal not found');
  const goalMeta = goal.metadata ? JSON.parse(goal.metadata) : {};

  await prisma.workUnit.update({
    where: { id: goalId },
    data: { status: 'active' },
  });

  const roles = await prisma.role.findMany({
    where: { companyId: goalMeta.companyId, status: 'active' },
    select: { type: true, name: true },
  });
  const roleTypes = [...new Set(roles.map(r => r.type))];

  const skills = skillStore.list({ companyId: goalMeta.companyId, status: 'published' });

  const prompt = `你是一个项目规划专家。请为以下目标生成详细的执行计划。

## 目标
- 标题：${goal.scope}
- 描述：${goalMeta.description || ''}
- 优先级：${goalMeta.priority || 'normal'}

${goalMeta.constraints ? `## 约束条件\n${JSON.stringify(goalMeta.constraints, null, 2)}` : ''}

${goalMeta.context ? `## 上下文\n${JSON.stringify(goalMeta.context, null, 2)}` : ''}

## 可用角色类型
${roleTypes.length > 0 ? roleTypes.join(', ') : 'developer, architect, tester, reviewer'}

## 可用 Skills
${skills.length > 0 ? skills.map(s => `${s.name} (${s.category})`).join(', ') : '暂无'}

请生成执行计划，输出 JSON 格式：
{
  "reasoning": "规划思路...",
  "estimatedTotalDuration": "预估总耗时",
  "requiredRoles": ["developer", "tester"],
  "steps": [
    {
      "index": 0,
      "title": "步骤标题",
      "description": "详细描述",
      "agentType": "developer",
      "input": {},
      "dependencies": [],
      "estimatedDuration": "预估耗时"
    }
  ]
}

要求：
1. 步骤要具体、可执行
2. 明确每步的输入输出关系（通过 dependencies 和 input 引用）
3. 合理分配角色
4. 考虑并行执行的可能性（无依赖关系的步骤可并行）`;

  const plan = await modelGateway.promptJson<GoalPlanDraft>(prompt, '你是一个专业的项目规划师。');

  // Store plan in goal metadata
  await prisma.workUnit.update({
    where: { id: goalId },
    data: {
      metadata: JSON.stringify({
        ...goalMeta,
        plan: {
          steps: plan.steps,
          reasoning: plan.reasoning,
          version: (goalMeta.plan?.version || 0) + 1,
          status: 'draft',
        },
      }),
    },
  });

  logger.info(`[Goal] Plan generated for ${goalId}: ${plan.steps.length} steps`);
  return plan;
}

/**
 * 审批计划
 */
export async function approvePlan(goalId: string): Promise<void> {
  const goal = await prisma.workUnit.findUnique({ where: { id: goalId } });
  if (!goal) throw new Error('Goal not found');
  const meta = goal.metadata ? JSON.parse(goal.metadata) : {};
  if (!meta.plan) throw new Error('No plan found');

  meta.plan.status = 'approved';
  await prisma.workUnit.update({
    where: { id: goalId },
    data: { status: 'active', metadata: JSON.stringify(meta) },
  });

  logger.info(`[Goal] Plan approved for ${goalId}`);
}

/**
 * 开始执行（创建 GoalExecution 记录）
 */
export async function startExecution(goalId: string): Promise<any[]> {
  const goal = await prisma.workUnit.findUnique({ where: { id: goalId } });
  if (!goal) throw new Error('Goal not found');
  const meta = goal.metadata ? JSON.parse(goal.metadata) : {};
  if (!meta.plan || meta.plan.status !== 'approved') throw new Error('No approved plan found');

  const steps = meta.plan.steps || [];
  const executions = [];

  for (const step of steps) {
    const execution = await prisma.workUnit.create({
      data: {
        parentId: goalId,
        scope: step.title || `step-${step.index}`,
        type: 'task',
        status: 'unassigned',
        metadata: JSON.stringify({
          stepIndex: step.index,
          agentType: step.agentType,
          input: step.input,
        }),
      },
    });
    executions.push(execution);
  }

  logger.info(`[Goal] Execution started for ${goalId}: ${executions.length} steps`);
  return executions;
}

/**
 * B1-002: 从 Channel RequirementsDoc 创建 Goal
 */
export async function createGoalFromChannelDoc(input: {
  title: string;
  summary: string;
  acGroups: Array<{ id: string; acs: string[]; files: string[]; dependencies: string[]; implementationNotes?: string; codePatterns?: string[]; gotchas?: string[]; architectureContext?: Record<string, any>; modelTier?: string; modelTierReason?: string }>;
  constraints?: string[];
  companyId: string;
  sourceChannelId: string;
  requirementsDocId: string;
  /** SP-004: SDD 文件 slug（用于文件系统查找） */
  sddSlug?: string;
  projectId?: string;
  workspaceRepoId?: string;
  risks?: string[];
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** TDD-07: Analyst 的契约测试（写入每个 worktree） */
  contractTests?: Array<{ file: string; content: string }>;
}) {
  const { title, summary, acGroups, constraints = [], companyId, sourceChannelId, requirementsDocId, sddSlug, projectId, workspaceRepoId, risks = [], contractTests } = input;

  // 去重防护：同 scope WorkUnit 24h 内 closed → 拒绝
  const recentFailures = await prisma.workUnit.count({
    where: {
      scope: title,
      status: 'closed',
      type: 'task',
      updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (recentFailures > 0) {
    throw new Error(
      `同标题 Goal 24h 内已失败 ${recentFailures} 次。请先审查失败原因再重新提交。标题: ${title.slice(0, 80)}`
    );
  }

  // B57-P5: AC 粒度质量门 — 每个 acGroup 文件数 ≤ 5
  const MAX_FILES_PER_AC_GROUP = 5;
  for (const group of acGroups) {
    if ((group.files?.length || 0) > MAX_FILES_PER_AC_GROUP) {
      throw new Error(
        `AC group "${group.id}" 涉及 ${group.files.length} 个文件（上限 ${MAX_FILES_PER_AC_GROUP}）。Analyst 必须拆分为更小的 AC 组。`
      );
    }
  }

  beforeGoalCreate({
    operation: 'goal_creation',
    taskDescription: summary || title,
  }).catch(err => logger.warn('[GoalService] beforeGoalCreate hook failed', { error: String(err) }));

  const groupIdToIndex = new Map(acGroups.map((g, i) => [g.id, i]));

  const steps: GoalStep[] = await Promise.all(acGroups.map(async (group, index) => {
    const model: ModelTier = (group.modelTier as ModelTier) || 'standard';
    return {
      index,
      title: group.id,
      description: group.acs.join('; '),
      agentType: 'claude',
      input: {
        taskType: 'sub-agent',
        acGroup: group,
        sourceChannelId,
        requirementsDocId,
        model,
        ...(contractTests?.length ? { contractTests } : {}),
      },
      dependencies: (group.dependencies || []).map(depId => {
        const depIndex = groupIdToIndex.get(depId);
        return depIndex !== undefined ? depIndex : -1;
      }).filter(i => i >= 0),
      estimatedDuration: model === 'fast' ? '15m' : model === 'premium' ? '45m' : '30m',
    };
  }));

  const priority = input.priority || (risks.includes('auth') || risks.includes('financial') ? 'high' :
    risks.includes('schema_change') ? 'critical' : 'normal');

  const goal = await prisma.workUnit.create({
    data: {
      scope: summary || title,
      type: 'task',
      status: 'active',
      metadata: JSON.stringify({
        description: `Auto-generated from RequirementsDoc (${acGroups.length} AC groups)`,
        priority,
        context: { sourceChannelId, requirementsDocId, sddSlug, projectId, workspaceRepoId, risks },
        companyId,
      }),
    },
  });

  for (const step of steps) {
    await prisma.workUnit.create({
      data: {
        parentId: goal.id,
        scope: step.title || `step-${step.index}`,
        type: 'task',
        status: 'unassigned',
        metadata: JSON.stringify({
          stepIndex: step.index,
          agentType: step.agentType,
          input: step.input,
        }),
      },
    });
  }

  logger.info(`[Goal] Created from Channel: goal=${goal.id}, ${steps.length} parallel steps`, {
    sourceChannelId,
    requirementsDocId,
    risks,
  });

  eventBus.publish('goal.created', { goalId: goal.id });
  // SSE push: 通知 CLI / 前端 Goal 已创建
  eventStore.publish('events', JSON.stringify({
    event_type: 'goal.created',
    event_id: uuidv4(),
    timestamp: new Date().toISOString(),
    data: { goalId: goal.id, title: goal.scope },
  })).catch(() => {});

  return { goalId: goal.id, stepCount: steps.length };
}

/**
 * 获取目标的可执行步骤（依赖已满足的 pending 步骤）
 */
export async function getExecutableSteps(goalId: string): Promise<any[]> {
  const goal = await prisma.workUnit.findUnique({ where: { id: goalId } });
  if (!goal) return [];
  const goalMeta = goal.metadata ? JSON.parse(goal.metadata) : {};

  const plan = goalMeta.plan;
  let steps: GoalStep[];
  let executions: any[];

  if (plan && plan.status === 'approved') {
    steps = plan.steps || [];
    logger.info('[Goal] Found plan', { goalId, stepCount: steps.length });
    executions = await prisma.workUnit.findMany({
      where: { parentId: goalId },
    });
  } else {
    executions = await prisma.workUnit.findMany({
      where: { parentId: goalId },
      orderBy: { createdAt: 'asc' },
    });
    steps = executions.map(e => {
      const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
      const input = eMeta.input || {};
      const acGroup = input?.acGroup || {};
      const stepIndex = eMeta.stepIndex ?? 0;
      return {
        index: stepIndex,
        title: acGroup.id || `step-${stepIndex}`,
        description: (acGroup.acs || []).join('; '),
        agentType: eMeta.agentType || 'claude',
        input,
        dependencies: (acGroup.dependencies || []).map((depId: string) => {
          const depExec = executions.find(ex => {
            const depMeta = ex.metadata ? JSON.parse(ex.metadata) : {};
            return depMeta.input?.acGroup?.id === depId;
          });
          const depMeta = depExec?.metadata ? JSON.parse(depExec.metadata) : {};
          return depMeta.stepIndex ?? -1;
        }).filter((i: number) => i >= 0),
        estimatedDuration: '30m',
      };
    });
    logger.info('[Goal] No plan — reconstructed from executions', { goalId, stepCount: steps.length });
  }

  const executionMap = new Map(executions.map(e => {
    const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
    return [eMeta.stepIndex ?? 0, e];
  }));
  const executable = [];

  for (const step of steps) {
    const exec = executionMap.get(step.index);
    if (!exec || exec.status !== 'unassigned') continue;

    const depsSatisfied = step.dependencies.every(depIndex => {
      const depExec = executionMap.get(depIndex);
      return depExec?.status === 'done';
    });

    if (depsSatisfied) {
      const depExecId = step.dependencies.length > 0
        ? executionMap.get(step.dependencies[0])?.id
        : undefined;
      executable.push({ ...exec, step, _baseBranchExecId: depExecId });
    }
  }

  const allRegularDone = steps.every(s => {
    const e = executionMap.get(s.index);
    return e?.status === 'done' || e?.status === 'closed';
  });

  if (allRegularDone && executable.length === 0) {
    const integrationExec = executions.find(e => {
      const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
      return eMeta.stepIndex === 999 && e.status === 'unassigned';
    });
    if (integrationExec) {
      executable.push({
        ...integrationExec,
        step: { index: 999, title: '集成验证', dependencies: steps.map(s => s.index) },
      });
    }
  }

  return executable;
}
