/**
 * Goal Service - Goal 驱动架构核心
 *
 * 人定义目标和约束，LLM 生成执行计划，系统自动调度执行。
 * 替代硬编码 workflow 的新范式。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway, type ModelTier } from '@dommaker/studio-shared';
import { tracePipeline } from '../monitoring/trace-pipeline.service.js';
import { beforeGoalCreate, checkBeforeTaskComplete } from '@dommaker/studio-shared/harness/hooks';
import { reviewAgent } from '../agents/review-agent.service.js';
import { recordPipelineRun } from '../../daemon/metrics.js';
import { AuditService } from '@dommaker/studio-audit';
import { deployAgent } from '../agents/deploy-agent.service.js';
import { triageAgent } from '../agents/triage-agent.service.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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

/**
 * Superpowers 三层模型路由：评估任务复杂度
 *
 * fast     (flash): 小改动、配置、文档
 * standard (flash): 常规开发
 * premium  (pro):   架构、重构、安全
 */
async function assessTaskComplexity(acGroup: { acs?: string[]; files?: string[] }): Promise<ModelTier> {
  const acs = acGroup.acs || [];
  const files = acGroup.files || [];
  const allText = [...acs, ...files].join(' ');

  const premiumKeywords = ['架构', '重构', '设计', '迁移', '集成', 'auth', '安全', '性能优化', '数据库迁移'];
  const fastKeywords = ['修复', 'fix', 'typo', '拼写', '配置', 'config', '文档', 'doc', '补充测试', '小改动', '更新', 'update', '依赖'];

  const isPremium = premiumKeywords.some(k => allText.toLowerCase().includes(k.toLowerCase()));
  const isFast = fastKeywords.some(k => allText.toLowerCase().includes(k.toLowerCase())) && acs.length <= 2 && files.length <= 3;

  let tier: ModelTier = 'standard';
  if (isPremium) tier = 'premium';
  else if (isFast) tier = 'fast';

  // Auditor→Analyst 反馈回路: 加载最新 tier 成功率，调整选择
  try {
    const latestStats = await prisma.decisionAudit.findFirst({
      where: { eventType: 'tier_success_rate' },
      orderBy: { createdAt: 'desc' },
      select: { summary: true },
    });
    if (latestStats?.summary) {
      const tierRates: Array<{ tier: string; total: number; failed: number; successRate: number }> =
        JSON.parse(latestStats.summary as string);
      const currentTier = tierRates.find(t => t.tier === tier);

      // 如果当前 tier 成功率 < 50% 且样本量 >= 5，降级
      if (currentTier && currentTier.total >= 5 && currentTier.successRate < 50) {
        if (tier === 'premium') tier = 'standard';
        else if (tier === 'fast') tier = 'standard';
      }
      // 如果 premium 比 standard 的 成功率更高，升级非 premium 任务
      const premiumStats = tierRates.find(t => t.tier === 'premium');
      const standardStats = tierRates.find(t => t.tier === 'standard');
      if (tier !== 'premium' && premiumStats && standardStats &&
          premiumStats.total >= 5 && standardStats.total >= 5 &&
          premiumStats.successRate > standardStats.successRate + 20) {
        tier = 'premium';
      }
    }
  } catch {
    // 反馈回路不影响主流程，静默降级
  }

  return tier;
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

// ─── Goal Service ───

export class GoalService {
  /**
   * 创建目标
   */
  async createGoal(input: CreateGoalInput): Promise<any> {
    const goal = await prisma.goal.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority || 'normal',
        constraints: input.constraints || {},
        context: input.context || {},
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
  async getGoal(goalId: string): Promise<any> {
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
  async listGoals(companyId: string, status?: string): Promise<any[]> {
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
   * 用 LLM 生成执行计划
   */
  async generatePlan(goalId: string): Promise<GoalPlanDraft> {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) throw new Error('Goal not found');

    // 更新状态为 planning
    await prisma.goal.update({
      where: { id: goalId },
      data: { status: 'planning' },
    });

    // 获取可用角色类型
    const roles = await prisma.role.findMany({
      where: { companyId: goal.companyId, status: 'active' },
      select: { type: true, name: true },
    });
    const roleTypes = [...new Set(roles.map(r => r.type))];

    // 获取可用 skills
    const skills = await prisma.companySkill.findMany({
      where: { companyId: goal.companyId, status: 'active' },
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

    // 保存计划
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
  async approvePlan(goalId: string): Promise<void> {
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
  async startExecution(goalId: string): Promise<any[]> {
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
   * 🆕 B1-002: 从 Channel RequirementsDoc 创建 Goal（不依赖 Meeting）
   *
   * 与 createGoalFromRequirementsDoc 逻辑一致，但直接从 acGroups 创建，
   * 不走 Meeting 查询。用于 Channel @Analyst → start_execution 链路。
   */
  async createGoalFromChannelDoc(input: {
    title: string;
    summary: string;
    acGroups: Array<{ id: string; acs: string[]; files: string[]; dependencies: string[]; implementationNotes?: string; codePatterns?: string[]; gotchas?: string[] }>;
    constraints?: string[];
    companyId: string;
    sourceChannelId: string;
    requirementsDocId: string;
    projectId?: string;
    risks?: string[];
    priority?: 'low' | 'normal' | 'high' | 'critical';
  }) {
    const { title, summary, acGroups, constraints = [], companyId, sourceChannelId, requirementsDocId, projectId, risks = [] } = input;

    // Phase 5: Goal 创建前 harness 检查
    beforeGoalCreate({
      operation: 'goal_creation',
      taskDescription: summary || title,
    }).catch(err => logger.warn('[GoalService] beforeGoalCreate hook failed', { error: String(err) }));

    const groupIdToIndex = new Map(acGroups.map((g, i) => [g.id, i]));

    const steps: GoalStep[] = await Promise.all(acGroups.map(async (group, index) => {
      const model = await assessTaskComplexity(group);
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
        },
        dependencies: (group.dependencies || []).map(depId => {
          const depIndex = groupIdToIndex.get(depId);
          return depIndex !== undefined ? depIndex : -1;
        }).filter(i => i >= 0),
        estimatedDuration: model === 'fast' ? '15m' : model === 'premium' ? '45m' : '30m',
      };
    }));

    // Create Goal
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

    // Create GoalPlan (approved, so GoalScheduler picks it up)
    const plan = await prisma.goalPlan.create({
      data: {
        goalId: goal.id,
        steps: JSON.stringify(steps) as any,
        reasoning: `Auto-generated from RequirementsDoc from channel ${sourceChannelId}: ${summary}. ${acGroups.length} parallel groups with ${constraints.length} constraints.`,
        version: 1,
        status: 'approved',
      },
    });

    // Create GoalExecutions (one per AC group, with planId)
    for (const step of steps) {
      await prisma.goalExecution.create({
        data: {
          goalId: goal.id,
          planId: plan.id,
          stepIndex: step.index,
          status: 'pending',
          agentType: step.agentType,
          input: JSON.stringify({
            ...(step.input as any || {}),
            stepTitle: step.title,
            stepDescription: step.description,
          }) as any,
        },
      });
    }

    logger.info(`[Goal] Created from Channel: goal=${goal.id}, ${steps.length} parallel steps`, {
      sourceChannelId,
      requirementsDocId,
      risks,
    });

    return { goalId: goal.id, planId: plan.id, stepCount: steps.length };
  }

  /**
   * 更新步骤执行状态
   */
  async updateStepExecution(
    executionId: string,
    updates: { status?: string; output?: any; error?: string; input?: any }
  ): Promise<any> {
    const execution = await prisma.goalExecution.update({
      where: { id: executionId },
      data: {
        ...updates,
        ...(updates.status === 'running' ? { startedAt: new Date() } : {}),
        ...(updates.status === 'succeeded' || updates.status === 'failed'
          ? { completedAt: new Date() }
          : {}),
      },
    });

    // 检查是否所有步骤都完成了
    if (updates.status === 'succeeded' || updates.status === 'failed') {
      await this.checkGoalCompletion(execution.goalId);
    }

    return execution;
  }

  /**
   * 检查目标是否完成
   */
  async checkGoalCompletion(goalId: string): Promise<void> {
    const executions = await prisma.goalExecution.findMany({
      where: { goalId },
    });

    // 零 execution = 损坏的 Goal → 标记 failed
    if (executions.length === 0) {
      logger.warn('[Goal] No executions found, marking failed', { goalId });
      await prisma.goal.update({
        where: { id: goalId }, data: { status: 'failed', completedAt: new Date() },
      });
      return;
    }

    const allDone = executions.every(e => e.status === 'succeeded' || e.status === 'failed');
    if (!allDone) return;

    const anyFailed = executions.some(e => e.status === 'failed');
    const newStatus = anyFailed ? 'failed' : 'succeeded';

    await prisma.goal.update({
      where: { id: goalId },
      data: {
        status: newStatus,
        completedAt: new Date(),
      },
    });

    logger.info(`[Goal] ${goalId} completed with status: ${newStatus}`);

    // 通知: 写 goal lifecycle 事件到独立文件（transport daemon 读取 → Discord）
    try {
      const { appendFileSync } = await import('fs');
      const { join } = await import('path');
      const { homedir } = await import('os');
      const eventsDir = process.env.EVENTS_DIR || join(homedir(), 'events');
      const { mkdirSync } = await import('fs');
      mkdirSync(eventsDir, { recursive: true });
      appendFileSync(
        join(eventsDir, 'studio.jsonl'),
        JSON.stringify({
          type: newStatus === 'succeeded' ? 'goal:completed' : 'goal:failed',
          goalId,
          status: newStatus,
          timestamp: new Date().toISOString(),
        }) + '\n',
      );
    } catch { /* non-blocking */ }

    // SPEC-1: auto-generate execution Document when Goal completes
    if (newStatus === 'succeeded') {
      this.createGoalDocument(goalId).catch(err =>
        logger.warn('[Goal] Document creation failed (non-blocking)', { goalId, error: String(err) })
      );
    }

    // ⑨: Trace 管道 — Goal 完成后自动分析 trace 数据
    tracePipeline.analyzeAfterGoalComplete(goalId).then(async result => {
      if (result && result.anomalies.length > 0) {
        const alerts = await tracePipeline.getAlerts(result);
        for (const alert of alerts) {
          logger.warn(`[TracePipeline] ${alert.level}: ${alert.message}`, { goalId });
        }
      }
    }).catch(err => {
      logger.warn('[TracePipeline] Analysis failed (non-blocking)', { goalId, error: String(err) });
    });

    // ⑯: Skill outcome tracking — record review result for skills used in this Goal
    this.trackSkillOutcomes(goalId, newStatus).catch(err => {
      logger.warn('[SkillOutcome] Tracking failed (non-blocking)', { goalId, error: String(err) });
    });

    if (newStatus === 'succeeded') {
      await this.handleGoalSucceeded(goalId);
    } else {
      await this.handleGoalFailed(goalId);
    }
  }

  /**
   * Goal 失败后：更新 Project 状态为 failed
   */
  private async handleGoalFailed(goalId: string): Promise<void> {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return;

    const projectId = (goal.context as unknown as Record<string, unknown>)?.projectId as string | undefined;

    // 查找失败原因
    const failedExec = await prisma.goalExecution.findFirst({
      where: { goalId, status: 'failed' },
      select: { id: true, error: true, stepIndex: true },
      orderBy: { stepIndex: 'desc' },
    });
    const errorMsg = (failedExec?.error as string) || 'Unknown failure';

    // Triage: 自动分析失败原因 → 决定重试/升级
    try {
      await triageAgent.handleAlert({
        type: 'zombie',
        severity: 'warning',
        message: `Goal ${goalId.slice(0, 8)} failed: ${errorMsg.slice(0, 200)}`,
        details: { goalId, executionId: failedExec?.id, projectId },
      });
      logger.info('[Goal] TriageAgent alerted for goal failure', { goalId });
    } catch (e) {
      logger.warn('[Goal] TriageAgent alert failed (non-blocking)', { error: String(e) });
    }

    if (!projectId) return;

    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'failed' },
    });
    logger.info(`[Goal] Project ${projectId} → failed`);
  }

  /**
   * 找审查 worktree：优先 integration step (stepIndex=999)，其次任一 succeeded step
   */
  private async findReviewWorktree(goalId: string): Promise<string | null> {
    const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

    // 优先找 integration step
    const integrationExec = await prisma.goalExecution.findFirst({
      where: { goalId, stepIndex: 999, status: 'succeeded' },
      select: { id: true },
    });
    if (integrationExec) {
      const wt = path.join(WORKTREES_DIR, integrationExec.id);
      if (fs.existsSync(wt)) return wt;
    }

    // 回退：任一 succeeded step
    const anyExec = await prisma.goalExecution.findFirst({
      where: { goalId, status: 'succeeded' },
      orderBy: { stepIndex: 'desc' },
      select: { id: true },
    });
    if (anyExec) {
      const wt = path.join(WORKTREES_DIR, anyExec.id);
      if (fs.existsSync(wt)) return wt;
    }

    return null;
  }

  /**
   * Goal 成功后：先审查，再决定放行还是打回
   */
  private async handleGoalSucceeded(goalId: string): Promise<void> {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return;

    const goalContext = (goal.context as unknown as Record<string, unknown>) || {};

    // 提取 ACs
    const plan = await prisma.goalPlan.findFirst({
      where: { goalId, status: 'approved' },
      orderBy: { version: 'desc' },
    });
    const steps = (plan?.steps as unknown as GoalStep[]) || [];
    const allAcs = steps.flatMap(s => {
      const input = s.input as Record<string, any> | null;
      return input?.acGroup?.acs || [];
    });

    // 找 worktree
    const worktree = await this.findReviewWorktree(goalId);
    if (!worktree) {
      logger.warn('[Goal] No review worktree found, proceeding to PR', { goalId });
      await this.finalizeGoalSucceeded(goalId);
      return;
    }

    const reviewCycle = (goalContext.reviewCycle as number) || 0;
    const projectId = (goalContext.projectId as string) || goalId;

    // Step 1: 运行 Reviewer
    logger.info('[Goal] Running Reviewer', { goalId, cycle: reviewCycle + 1 });
    let review: { approved: boolean; score: number; issues: any[]; suggestions: string[] };
    try {
      review = await reviewAgent.review({
        taskId: goalId,
        projectId,
        worktree,
        taskDescription: goal.title,
        acceptanceCriteria: allAcs.length > 0 ? allAcs : undefined,
        cycle: reviewCycle + 1,
      });
    } catch (err) {
      logger.error('[Goal] Reviewer crashed, defaulting to pass', { goalId, error: String(err) });
      await this.finalizeGoalSucceeded(goalId);
      return;
    }

    if (review.approved) {
      // Step 2a: 审查通过 → PR + Project 更新
      logger.info('[Goal] Review approved', { goalId, score: review.score, cycle: reviewCycle + 1 });
      await this.finalizeGoalSucceeded(goalId);
    } else if (reviewCycle + 1 >= 3) {
      // Step 2b: 3 轮耗尽 → 升级人工介入
      logger.warn('[Goal] Review max cycles exhausted, escalating', { goalId, cycles: reviewCycle + 1, score: review.score });
      await prisma.goal.update({
        where: { id: goalId },
        data: {
          status: 'blocked',
          context: { ...goalContext, reviewCycle: reviewCycle + 1, reviewScore: review.score } as any,
        },
      });
    } else {
      // Step 2c: 审查未通过 → 打回修复
      logger.info('[Goal] Review not approved, re-queuing for fixes', { goalId, cycle: reviewCycle + 1, score: review.score });

      // 更新 review cycle，Goal 回到 executing 状态让 GoalScheduler 重新调度
      await prisma.goal.update({
        where: { id: goalId },
        data: {
          status: 'executing',
          context: { ...goalContext, reviewCycle: reviewCycle + 1 } as any,
        },
      });

      // 重置最后完成的 execution（integration step）为 pending，带 fix context
      const lastExec = await prisma.goalExecution.findFirst({
        where: { goalId, status: 'succeeded' },
        orderBy: { stepIndex: 'desc' },
      });
      if (lastExec) {
        await prisma.goalExecution.update({
          where: { id: lastExec.id },
          data: {
            status: 'pending',
            input: {
              ...((lastExec.input as unknown as Record<string, unknown>) || {}),
              taskType: 'review-fix',
              fixContext: review.issues.map(i => `[${i.severity}] ${i.message}`).join('\n'),
              reviewCycle: reviewCycle + 1,
            } as any,
          },
        });
      }
    }
  }

  /**
   * Goal 审查通过后：创建 PR + 更新 Project 状态 + 更新 OKR
   */
  private async finalizeGoalSucceeded(goalId: string): Promise<void> {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return;

    const projectId = (goal.context as unknown as Record<string, unknown>)?.projectId as string | undefined;
    if (!projectId) {
      logger.info('[Goal] No projectId in goal context, skipping PR/project update', { goalId });
      return;
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, pmoNumber: true, gitBranch: true, gitRepo: true, status: true, okrId: true },
    });
    if (!project) return;

    // Test gate: 从 worktree 读 .progress.json 验证测试通过
    try {
      const worktree = await this.findReviewWorktree(goalId);
      if (worktree) {
        const progressPath = path.join(worktree, '.progress.json');
        if (fs.existsSync(progressPath)) {
          const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
          const testResults = progress.testResults || { passed: 0, failed: 0, total: 0 };
          const { allowed, violations } = await checkBeforeTaskComplete([{
            passed: testResults.failed === 0,
            command: 'npm test',
            failures: [],
          }]);
          if (!allowed) {
            logger.warn('[Goal] Test gate blocked finalization', { goalId, violations });
            return;
          }
        }
      }
    } catch (e) {
      logger.warn('[Goal] Test gate check failed (non-blocking)', { error: String(e) });
    }

    // PR creation — previously delegated to meetings/task-assignment.service.ts (module deleted)
    if (project.gitBranch) {
      logger.info(`[Goal] PR creation skipped (meeting module removed) for project ${project.pmoNumber}`);
    }

    // 更新 Project 状态为 in_review
    if (project.status === 'active') {
      await prisma.project.update({
        where: { id: projectId },
        data: { status: 'in_review' },
      });
      logger.info(`[Goal] Project ${project.pmoNumber} → in_review`);
    }

    // 更新 OKR 进度
    if (project.okrId) {
      try {
        const { okrService } = await import('../pmo/okr.service');
        await okrService.updateProgress(project.okrId);
      } catch {
        logger.warn('[Goal] Failed to update OKR progress');
      }
    }

    // Deploy 就绪检查 (non-blocking)
    try {
      const worktree = await this.findReviewWorktree(goalId);
      if (worktree) {
        const result = await deployAgent.deploy({
          projectId,
          executionId: goalId,
          worktree,
          environment: 'vps',
          taskDescription: goal.title,
        });
        logger.info('[Goal] Deploy check completed', {
          goalId,
          success: result.success,
          findings: result.findings.length,
        });
      }
    } catch (e) {
      logger.warn('[Goal] Deploy check failed (non-blocking)', { error: String(e) });
    }

    // P0.2: 管线总结 + 指标记录 + 审计日志
    await this.recordGoalCompletion(goalId);
  }

  /** 记录 Goal 完成指标、审计日志、生成总结 */
  private async recordGoalCompletion(goalId: string): Promise<void> {
    try {
      const goal = await prisma.goal.findUnique({ where: { id: goalId } });
      if (!goal) return;

      // 汇总所有 execution 的 PipelineRun 数据
      const runs = await prisma.pipelineRun.findMany({
        where: { sessionId: { in: (await prisma.goalExecution.findMany({
          where: { goalId },
          select: { id: true },
        })).map(e => e.id) } },
      });

      const totalInputTokens = runs.reduce((s, r) => s + r.inputTokens, 0);
      const totalOutputTokens = runs.reduce((s, r) => s + r.outputTokens, 0);
      const totalDurationMs = runs.reduce((s, r) => s + r.durationMs, 0);
      const totalSessions = runs.length;
      const successCount = runs.filter(r => r.success).length;

      // 记录全管线 PipelineRun
      await recordPipelineRun({
        source: 'pipeline', phase: 'full',
        taskName: goal.title,
        model: 'summary',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheHitTokens: runs.reduce((s, r) => s + r.cacheHitTokens, 0),
        durationMs: totalDurationMs,
        success: goal.status === 'succeeded',
        testPassed: successCount === totalSessions,
      });

      // 审计日志
      try {
        const auditService = new AuditService(prisma);
        await auditService.log({
          action: 'goal_completed',
          resource: 'goal',
          resourceId: goalId,
          details: {
            title: goal.title,
            status: goal.status,
            totalInputTokens,
            totalOutputTokens,
            totalDurationMs,
            totalSessions,
            successCount,
          },
          status: 'success',
        });
      } catch { /* non-blocking */ }

      logger.info('[Goal] Pipeline summary recorded', {
        goalId,
        title: goal.title,
        sessions: totalSessions,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        durationMs: totalDurationMs,
      });

      // P0.5: 推送管线总结到 Channel
      try {
        const ctx = (goal.context as unknown as Record<string, unknown>) || {};
        const sourceChannelId = ctx.sourceChannelId as string | undefined;
        if (sourceChannelId) {
          const { channelMessageService } = await import('../channels/channel-message.service.js');
          const durationMin = Math.round(totalDurationMs / 60000);
          const tokenK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
          const summary = [
            `## Goal 完成: ${goal.title}`,
            `- 状态: ${goal.status === 'succeeded' ? '✅ 成功' : goal.status === 'failed' ? '❌ 失败' : '⏳ ' + goal.status}`,
            `- Session: ${totalSessions} 轮`,
            `- Token: ${tokenK(totalInputTokens)} → ${tokenK(totalOutputTokens)}`,
            `- 耗时: ${durationMin} min`,
            `- 执行步: ${successCount}/${totalSessions} 成功`,
          ].join('\n');
          await channelMessageService.createAgentMessage(sourceChannelId, 'Executor', summary, {
            goalId,
            cardType: 'goal_summary',
          });
        }
      } catch (e) {
        logger.warn('[Goal] Failed to send summary card', { goalId, error: String(e) });
      }
    } catch (e) {
      logger.warn('[Goal] Failed to record completion metrics', { goalId, error: String(e) });
    }
  }

  /**
   * 获取目标的可执行步骤（依赖已满足的 pending 步骤）
   */
  async getExecutableSteps(goalId: string): Promise<any[]> {
    const plan = await prisma.goalPlan.findFirst({
      where: { goalId, status: 'approved' },
      orderBy: { version: 'desc' },
    });
    if (!plan) { logger.info('[Goal] No approved plan found', { goalId }); return []; }

    const steps = parseJsonField<GoalStep[]>(plan.steps, []);
    logger.info('[Goal] Found plan', { goalId, planId: plan.id, stepCount: steps.length, stepsType: typeof plan.steps });
    const executions = await prisma.goalExecution.findMany({
      where: { goalId, planId: plan.id },
    });

    const executionMap = new Map(executions.map(e => [e.stepIndex, e]));
    const executable = [];

    for (const step of steps) {
      const exec = executionMap.get(step.index);
      if (!exec || exec.status !== 'pending') continue;

      // 检查依赖是否都已完成
      const depsSatisfied = step.dependencies.every(depIndex => {
        const depExec = executionMap.get(depIndex);
        return depExec?.status === 'succeeded';
      });

      if (depsSatisfied) {
        executable.push({ ...exec, step });
      }
    }

    // 集成步骤：所有常规步骤完成后才可执行
    // 集成步骤 stepIndex 固定为 999，不在 plan.steps 中，需单独处理
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

  /**
   * 删除目标
   */
  async deleteGoal(goalId: string): Promise<void> {
    await prisma.goal.delete({ where: { id: goalId } });
    logger.info(`[Goal] Deleted: ${goalId}`);
  }

  /**
   * 取消 GoalExecution — 用户中断正在运行的 Agent
   */
  async cancelGoalExecution(executionId: string): Promise<any> {
    const execution = await prisma.goalExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new Error(`GoalExecution not found: ${executionId}`);
    if (execution.status !== 'running' && execution.status !== 'pending') {
      throw new Error(`Cannot cancel execution with status: ${execution.status}`);
    }

    const updated = await prisma.goalExecution.update({
      where: { id: executionId },
      data: {
        status: 'failed',
        error: { message: '用户取消', cancelledAt: new Date().toISOString() },
        completedAt: new Date(),
      },
    });

    logger.info(`[Goal] Execution cancelled: ${executionId}`);
    await this.checkGoalCompletion(execution.goalId);
    return updated;
  }

  /**
   * 重试 GoalExecution — 重置失败的任务让 GoalScheduler 重新分派
   */
  async retryGoalExecution(executionId: string): Promise<any> {
    const execution = await prisma.goalExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new Error(`GoalExecution not found: ${executionId}`);
    if (execution.status !== 'failed') {
      throw new Error(`Can only retry failed executions, current: ${execution.status}`);
    }

    const updated = await prisma.goalExecution.update({
      where: { id: executionId },
      data: {
        status: 'pending',
        error: null,
        completedAt: null,
        startedAt: null,
      },
    });

    logger.info(`[Goal] Execution retried: ${executionId}`);
    return updated;
  }

  /**
   * ⑯: Skill outcome tracking — 记录 Goal 中使用的 Skill 的 Review 结果
   */
  private async trackSkillOutcomes(goalId: string, goalStatus: string): Promise<void> {
    try {
      // 查询此 Goal 关联的 Skill（通过 SkillProposal.sourceGoalIds）
      const proposals = await prisma.skillProposal.findMany({
        where: {
          status: { in: ['approved', 'pending'] },
        },
        include: { skill: true },
      });

      const related = proposals.filter(p => {
        try {
          const meta = p.skill?.metadata as any;
          const goalIds: string[] = meta?.sourceGoalIds || [];
          return goalIds.includes(goalId);
        } catch { return false; }
      });

      if (related.length === 0) return;

      const outcome = goalStatus === 'succeeded' ? 'passed' : 'failed';
      for (const p of related) {
        await prisma.skillProposal.update({
          where: { id: p.id },
          data: {
            metadata: {
              ...((p.skill?.metadata as any) || {}),
              lastReviewOutcome: outcome,
              lastReviewGoalId: goalId,
              lastReviewAt: new Date().toISOString(),
            },
          } as any,
        });

        // Update skill usage metadata
        if (p.skill) {
          const currentMeta = (p.skill.metadata as any) || {};
          const reviewHistory = [...(currentMeta.reviewOutcomes || []), { goalId, outcome, at: new Date().toISOString() }];
          await prisma.skill.update({
            where: { id: p.skill.id },
            data: {
              metadata: { ...currentMeta, reviewOutcomes: reviewHistory.slice(-20) },
              status: currentMeta.status || p.skill.status,
            } as any,
          });
        }
      }

      logger.info(`[SkillOutcome] Tracked ${related.length} skills for goal ${goalId} (${outcome})`);
    } catch (err) {
      logger.warn('[SkillOutcome] Failed', { goalId, error: String(err) });
    }
  }

  /**
   * SPEC-1: Goal 完成时自动生成 execution Document
   */
  private async createGoalDocument(goalId: string): Promise<void> {
    try {
      const goal = await prisma.goal.findUnique({
        where: { id: goalId },
        select: { id: true, title: true, companyId: true, projectId: true },
      });
      if (!goal?.companyId) return;

      const execs = await prisma.goalExecution.findMany({
        where: { goalId },
        select: { id: true, output: true, stepIndex: true, status: true },
        take: 10,
      });

      const summary = execs.map(e =>
        `- Step ${e.stepIndex}: ${e.status} (${(e.output as any)?.summary || 'no summary'})`
      ).join('\n');

      await prisma.document.create({
        data: {
          projectId: goal.projectId || goal.id,
          companyId: goal.companyId,
          type: 'execution',
          title: goal.title || `Goal ${goalId.slice(0, 8)}`,
          content: `## Execution Summary\n\nGoal: ${goal.title}\nID: ${goalId}\n\n### Steps\n${summary}`,
          status: 'active',
          tags: '[]',
        },
      });

      logger.info(`[Goal] Document created for ${goalId.slice(0, 8)}`);
    } catch (err) {
      logger.warn('[Goal] Document creation failed', { goalId, error: String(err) });
    }
  }
}

export const goalService = new GoalService();
