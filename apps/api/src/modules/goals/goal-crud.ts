/**
 * Goal CRUD — 创建/读取/更新/删除操作
 *
 * 从 goal.service.ts 提取的纯函数。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway, eventBus, type ModelTier } from '@dommaker/studio-shared';
import { beforeGoalCreate } from '@dommaker/studio-shared/harness/hooks';

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
  const goal = await prisma.goal.create({
    data: {
      title: input.title,
      description: input.description,
      priority: input.priority || 'normal',
      constraints: JSON.stringify(input.constraints || {}),
      context: JSON.stringify(input.context || {}),
      companyId: input.companyId,
      createdBy: input.createdBy,
      status: 'draft',
    },
  });

  logger.info(`[Goal] Created: ${goal.id} (${goal.title})`);
  return goal;
}

/**
 * 获取目标详情
 */
export async function getGoal(goalId: string): Promise<any> {
  return prisma.goal.findUnique({
    where: { id: goalId },
    include: {
      GoalPlan: { orderBy: { version: 'desc' }, take: 1 },
      GoalExecution: { orderBy: { createdAt: 'desc' } },
    },
  });
}

/**
 * 获取公司的目标列表
 */
export async function listGoals(companyId: string, status?: string): Promise<any[]> {
  return prisma.goal.findMany({
    where: {
      companyId,
      ...(status ? { status } : {}),
    },
    include: {
      GoalPlan: { orderBy: { version: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * 删除目标
 */
export async function deleteGoal(goalId: string): Promise<void> {
  await prisma.goal.delete({ where: { id: goalId } });
  logger.info(`[Goal] Deleted: ${goalId}`);
}

/**
 * 用 LLM 生成执行计划
 */
export async function generatePlan(goalId: string): Promise<GoalPlanDraft> {
  const goal = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!goal) throw new Error('Goal not found');

  await prisma.goal.update({
    where: { id: goalId },
    data: { status: 'planning' },
  });

  const roles = await prisma.role.findMany({
    where: { companyId: goal.companyId, status: 'active' },
    select: { type: true, name: true },
  });
  const roleTypes = [...new Set(roles.map(r => r.type))];

  const skills = await prisma.skill.findMany({
    where: { companyId: goal.companyId, status: 'published' },
    select: { name: true, category: true },
  });

  const prompt = `你是一个项目规划专家。请为以下目标生成详细的执行计划。

## 目标
- 标题：${goal.title}
- 描述：${goal.description}
- 优先级：${goal.priority}

${goal.constraints ? `## 约束条件\n${JSON.stringify(goal.constraints, null, 2)}` : ''}

${goal.context ? `## 上下文\n${JSON.stringify(goal.context, null, 2)}` : ''}

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

  const existingPlans = await prisma.goalPlan.count({ where: { goalId } });
  await prisma.goalPlan.create({
    data: {
      goalId,
      steps: plan.steps as any,
      reasoning: plan.reasoning,
      version: existingPlans + 1,
      status: 'draft',
    },
  });

  logger.info(`[Goal] Plan generated for ${goalId}: ${plan.steps.length} steps`);
  return plan;
}

/**
 * 审批计划
 */
export async function approvePlan(goalId: string): Promise<void> {
  const plan = await prisma.goalPlan.findFirst({
    where: { goalId },
    orderBy: { version: 'desc' },
  });
  if (!plan) throw new Error('No plan found');

  await prisma.goalPlan.update({
    where: { id: plan.id },
    data: { status: 'approved' },
  });

  await prisma.goal.update({
    where: { id: goalId },
    data: { status: 'executing' },
  });

  logger.info(`[Goal] Plan approved for ${goalId}`);
}

/**
 * 开始执行（创建 GoalExecution 记录）
 */
export async function startExecution(goalId: string): Promise<any[]> {
  const plan = await prisma.goalPlan.findFirst({
    where: { goalId, status: 'approved' },
    orderBy: { version: 'desc' },
  });
  if (!plan) throw new Error('No approved plan found');

  const steps = parseJsonField<GoalStep[]>(plan.steps, []);
  const executions = [];

  for (const step of steps) {
    const execution = await prisma.goalExecution.create({
      data: {
        goalId,
        planId: plan.id,
        stepIndex: step.index,
        status: 'pending',
        agentType: step.agentType,
        input: JSON.stringify(step.input) as any,
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
  projectId?: string;
  risks?: string[];
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** TDD-07: Analyst 的契约测试（写入每个 worktree） */
  contractTests?: Array<{ file: string; content: string }>;
}) {
  const { title, summary, acGroups, constraints = [], companyId, sourceChannelId, requirementsDocId, projectId, risks = [], contractTests } = input;

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

  const goal = await prisma.goal.create({
    data: {
      title: summary || title,
      description: `Auto-generated from RequirementsDoc (${acGroups.length} AC groups)`,
      priority,
      context: JSON.stringify({ sourceChannelId, requirementsDocId, projectId, risks }) as any,
      companyId,
      status: 'executing',
    },
  });

  for (const step of steps) {
    await prisma.goalExecution.create({
      data: {
        goalId: goal.id,
        stepIndex: step.index,
        status: 'pending',
        agentType: step.agentType,
        input: JSON.stringify(step.input) as any,
      },
    });
  }

  logger.info(`[Goal] Created from Channel: goal=${goal.id}, ${steps.length} parallel steps`, {
    sourceChannelId,
    requirementsDocId,
    risks,
  });

  eventBus.publish('goal.created', { goalId: goal.id });

  return { goalId: goal.id, stepCount: steps.length };
}

/**
 * 获取目标的可执行步骤（依赖已满足的 pending 步骤）
 */
export async function getExecutableSteps(goalId: string): Promise<any[]> {
  const plan = await prisma.goalPlan.findFirst({
    where: { goalId, status: 'approved' },
    orderBy: { version: 'desc' },
  });

  let steps: GoalStep[];
  let executions: any[];

  if (plan) {
    steps = parseJsonField<GoalStep[]>(plan.steps, []);
    logger.info('[Goal] Found plan', { goalId, planId: plan.id, stepCount: steps.length });
    executions = await prisma.goalExecution.findMany({
      where: { goalId, planId: plan.id },
    });
  } else {
    executions = await prisma.goalExecution.findMany({
      where: { goalId },
      orderBy: { stepIndex: 'asc' },
    });
    steps = executions.map(e => {
      const input = parseJsonField<Record<string, any>>(e.input, {});
      const acGroup = input?.acGroup || {};
      return {
        index: e.stepIndex,
        title: acGroup.id || `step-${e.stepIndex}`,
        description: (acGroup.acs || []).join('; '),
        agentType: e.agentType || 'claude',
        input,
        dependencies: (acGroup.dependencies || []).map((depId: string) => {
          const depExec = executions.find(ex => {
            const depInput = parseJsonField<Record<string, any>>(ex.input, {});
            return depInput?.acGroup?.id === depId;
          });
          return depExec?.stepIndex ?? -1;
        }).filter((i: number) => i >= 0),
        estimatedDuration: '30m',
      };
    });
    logger.info('[Goal] No GoalPlan — reconstructed from executions', { goalId, stepCount: steps.length });
  }

  const executionMap = new Map(executions.map(e => [e.stepIndex, e]));
  const executable = [];

  for (const step of steps) {
    const exec = executionMap.get(step.index);
    if (!exec || exec.status !== 'pending') continue;

    const depsSatisfied = step.dependencies.every(depIndex => {
      const depExec = executionMap.get(depIndex);
      return depExec?.status === 'succeeded';
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
    return e?.status === 'succeeded' || e?.status === 'failed';
  });

  if (allRegularDone && executable.length === 0) {
    const integrationExec = executions.find(
      e => e.stepIndex === 999 && e.status === 'pending',
    );
    if (integrationExec) {
      executable.push({
        ...integrationExec,
        step: { index: 999, title: '集成验证', dependencies: steps.map(s => s.index) },
      });
    }
  }

  return executable;
}
