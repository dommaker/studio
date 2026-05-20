/**
 * AgentRouter - Layer 2 of three-layer Agent architecture (§12.10)
 *
 * 纯执行层，不感知业务逻辑。
 * 职责：
 * 1. 从 DB 读取 ExecutionPlan
 * 2. 根据任务类型匹配 agent 能力
 * 3. 分配给合适的 agent 执行
 * 4. 将 ExecutionResult 写回 DB
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { beforeAgentDispatch, buildAgentConstraintPrompt } from '@dommaker/studio-shared/harness/hooks';

// ─── 类型 ───

export interface AgentCapability {
  agentType: string;           // codex/claude/opencode/llm
  supportedTasks: string[];    // code/review/analysis/writing
  maxConcurrent: number;
  priority: number;
}

export interface RouteDecision {
  agentType: string;
  reason: string;
}

// ─── 默认 agent 能力配置 ───

const DEFAULT_CAPABILITIES: AgentCapability[] = [
  {
    agentType: 'claude',
    supportedTasks: ['code', 'review', 'analysis', 'writing', 'architecture', 'planning'],
    maxConcurrent: 3,
    priority: 10,
  },
  {
    agentType: 'codex',
    supportedTasks: ['code', 'refactor', 'test'],
    maxConcurrent: 5,
    priority: 8,
  },
  {
    agentType: 'opencode',
    supportedTasks: ['code', 'review'],
    maxConcurrent: 3,
    priority: 6,
  },
  {
    agentType: 'llm',
    supportedTasks: ['analysis', 'writing', 'summarization', 'extraction'],
    maxConcurrent: 10,
    priority: 4,
  },
];

// ─── AgentRouter ───

export class AgentRouter {
  private capabilities: AgentCapability[];
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(capabilities?: AgentCapability[]) {
    this.capabilities = capabilities || DEFAULT_CAPABILITIES;
  }

  /**
   * 路由决策：根据任务类型选择最合适的 agent
   */
  route(taskType: string, context?: Record<string, any>): RouteDecision {
    // 按优先级排序，找到支持该任务类型的 agent
    const candidates = this.capabilities
      .filter(c => c.supportedTasks.includes(taskType))
      .sort((a, b) => b.priority - a.priority);

    if (candidates.length === 0) {
      // 默认使用 LLM
      return { agentType: 'llm', reason: `No agent found for task type "${taskType}", falling back to LLM` };
    }

    // 选择优先级最高的
    const chosen = candidates[0];
    return { agentType: chosen.agentType, reason: `Best match for "${taskType}" (priority ${chosen.priority})` };
  }

  /**
   * 处理待执行的计划
   * 从 DB 读取 pending plans，分配 agent，并行执行
   */
  async processPendingPlans(): Promise<number> {
    const pendingPlans = await prisma.executionPlan.findMany({
      where: { status: 'pending' },
      orderBy: { priority: 'desc' },
      take: 10,
    });

    if (pendingPlans.length === 0) return 0;

    // 原子 CAS：批量标记为 assigned
    const assigned: typeof pendingPlans = [];
    for (const plan of pendingPlans) {
      const updateResult = await prisma.executionPlan.updateMany({
        where: { id: plan.id, status: 'pending' },
        data: { status: 'assigned', assignedTo: 'llm' },
      });
      if (updateResult.count > 0) assigned.push(plan);
    }

    if (assigned.length === 0) return 0;

    // 并行执行所有已分配的计划
    const results = await Promise.allSettled(
      assigned.map(plan => this.executePlan(plan.id))
    );

    let processed = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        processed++;
      } else {
        logger.error({ planId: assigned[i].id, error: String(result.reason) }, 'Failed to process plan');
        await this.handlePlanFailure(assigned[i].id, result.reason);
      }
    }

    return processed;
  }

  /**
   * 处理计划失败：重试或进入死信
   */
  private async handlePlanFailure(planId: string, error: unknown): Promise<void> {
    const MAX_RETRIES = 3;

    const plan = await prisma.executionPlan.findUnique({
      where: { id: planId },
      select: { id: true, plan: true },
    });
    if (!plan) return;

    const planData = plan.plan as any;
    const retryCount = (planData?.retryCount || 0) + 1;

    if (retryCount < MAX_RETRIES) {
      // 重试：重置为 pending，记录重试次数
      await prisma.executionPlan.update({
        where: { id: planId },
        data: {
          status: 'pending',
          plan: { ...planData, retryCount, lastError: String(error) },
        },
      });
      logger.warn({ planId, retryCount, maxRetries: MAX_RETRIES }, 'Plan queued for retry');
    } else {
      // 死信：超过最大重试次数
      await prisma.executionPlan.update({
        where: { id: planId },
        data: {
          status: 'dead_letter',
          completedAt: new Date(),
          plan: { ...planData, retryCount, lastError: String(error), deadLetterAt: new Date().toISOString() },
        },
      });
      logger.error({ planId, retryCount }, 'Plan moved to dead letter queue');
    }
  }

  /**
   * 执行单个计划
   */
  async executePlan(planId: string): Promise<void> {
    const plan = await prisma.executionPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) throw new Error(`Plan not found: ${planId}`);

    const startTime = Date.now();

    try {
      // Harness: dispatch 前检查
      try {
        await beforeAgentDispatch({
          operation: 'code_implementation',
          taskDescription: plan.title || `ExecutionPlan:${planId}`,
        });
      } catch (err) {
        logger.warn('[AgentRouter] beforeAgentDispatch failed, continuing', { planId, error: String(err) });
      }

      // 标记为运行中
      await prisma.executionPlan.update({
        where: { id: planId },
        data: { status: 'running', startedAt: new Date() },
      });

      // 解析计划
      const planData = plan.plan as any;
      const steps = planData?.steps || [];

      // Harness: 约束注入 + 执行
      const taskDescription = steps.map((s: any) => s.task).join('\n');
      const constraintPrompt = buildAgentConstraintPrompt({
        operation: 'code_implementation',
        taskDescription,
      });
      const prompt = constraintPrompt
        ? `${constraintPrompt}\n\nExecute the following tasks and provide results:\n\n${taskDescription}`
        : `Execute the following tasks and provide results:\n\n${taskDescription}`;
      const result = await modelGateway.prompt(
        'agent_default',
        prompt,
        { maxTokens: 2000 }
      );

      const durationMs = Date.now() - startTime;

      // 写入结果
      await prisma.executionResult.create({
        data: {
          planId,
          agentType: plan.assignedTo || 'llm',
          status: 'success',
          output: { result: result.content },
          tokenUsage: result.usage,
          durationMs,
        },
      });

      // 标记计划完成
      await prisma.executionPlan.update({
        where: { id: planId },
        data: { status: 'completed', completedAt: new Date() },
      });

      logger.info({ planId, durationMs }, 'Execution plan completed');
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // 使用 upsert 避免重试时 unique 约束冲突
      await prisma.executionResult.upsert({
        where: { planId },
        create: {
          planId,
          agentType: plan.assignedTo || 'llm',
          status: 'failed',
          error: String(error),
          durationMs,
        },
        update: {
          status: 'failed',
          error: String(error),
          durationMs,
        },
      });

      await prisma.executionPlan.update({
        where: { id: planId },
        data: { status: 'failed', completedAt: new Date() },
      });

      throw error;
    }
  }

  /**
   * 启动自动调度器
   * 定期扫描 pending plans 并自动执行
   */
  startScheduler(intervalMs = 10000): void {
    if (this.schedulerInterval) {
      logger.warn('AgentRouter scheduler already running');
      return;
    }

    logger.info({ intervalMs }, 'Starting AgentRouter scheduler');

    this.schedulerInterval = setInterval(async () => {
      if (this.isProcessing) return;

      this.isProcessing = true;
      try {
        const processed = await this.processPendingPlans();
        if (processed > 0) {
          logger.info({ processed }, 'Auto-processed execution plans');
        }
      } catch (error) {
        logger.error({ error: String(error) }, 'Scheduler tick failed');
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);
  }

  /**
   * 停止自动调度器
   */
  stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      logger.info('AgentRouter scheduler stopped');
    }
  }

  /**
   * 获取路由统计
   */
  async getStats(): Promise<Record<string, any>> {
    const [byStatus, total] = await Promise.all([
      prisma.executionPlan.groupBy({
        by: ['status'],
        _count: true,
      }),
      prisma.executionPlan.count(),
    ]);

    const statusMap: Record<string, number> = {};
    for (const row of byStatus) {
      statusMap[row.status] = row._count;
    }

    return {
      total,
      pending: statusMap['pending'] || 0,
      running: statusMap['running'] || 0,
      completed: statusMap['completed'] || 0,
      failed: statusMap['failed'] || 0,
      dead_letter: statusMap['dead_letter'] || 0,
    };
  }
}

export const agentRouter = new AgentRouter();
