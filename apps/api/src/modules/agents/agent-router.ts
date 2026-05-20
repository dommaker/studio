/**
 * AgentRouter - Layer 2 of three-layer Agent architecture (§12.10)
 *
 * 纯执行层，不感知业务逻辑。
 * ExecutionPlan/ExecutionResult 模型已删除，此模块为简化占位。
 * 路由逻辑迁移至 Goal 管线 (goal-scheduler.ts)。
 */

import { logger } from '@dommaker/studio-shared';

// ─── 类型 ───

export interface AgentCapability {
  agentType: string;
  supportedTasks: string[];
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

// ─── AgentRouter (简化占位) ───

export class AgentRouter {
  private capabilities: AgentCapability[];
  private schedulerInterval: NodeJS.Timeout | null = null;

  constructor(capabilities?: AgentCapability[]) {
    this.capabilities = capabilities || DEFAULT_CAPABILITIES;
  }

  /**
   * 路由决策：根据任务类型选择最合适的 agent
   */
  route(taskType: string, _context?: Record<string, any>): RouteDecision {
    const candidates = this.capabilities
      .filter(c => c.supportedTasks.includes(taskType))
      .sort((a, b) => b.priority - a.priority);

    if (candidates.length === 0) {
      return { agentType: 'llm', reason: `No agent found for task type "${taskType}", falling back to LLM` };
    }

    const chosen = candidates[0];
    return { agentType: chosen.agentType, reason: `Best match for "${taskType}" (priority ${chosen.priority})` };
  }

  /**
   * 启动自动调度器（ExecutionPlan 模型已删除，仅保留日志占位）
   */
  startScheduler(_intervalMs = 15000): void {
    if (this.schedulerInterval) {
      logger.warn('AgentRouter scheduler already running');
      return;
    }

    logger.info('[AgentRouter] Scheduler started (deprecated — ExecutionPlan models removed)');
    this.schedulerInterval = setInterval(() => {
      // ExecutionPlan/ExecutionResult models have been deleted.
      // Scheduling is handled by GoalScheduler.
    }, 30000);
  }

  /**
   * 停止自动调度器
   */
  stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      logger.info('[AgentRouter] Scheduler stopped');
    }
  }
}

export const agentRouter = new AgentRouter();
