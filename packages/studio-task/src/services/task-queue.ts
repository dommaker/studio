/**
 * TaskQueue - 任务队列管理器
 * 
 * 基于 MemoryStore 实现的任务队列
 */

import { randomUUID } from 'crypto';
import { logger, memoryStore } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';

// 重试配置
export const RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 5000,
  backoffMultiplier: 2,
  maxRetryDelay: 60000,
};

export interface Task {
  id: string;
  executionId: string;
  nodeId: string;
  agentType: string;
  prompt: string;
  parameters?: Record<string, any>;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'retrying';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  output?: any;
  error?: string;
  progress?: number;
  message?: string;
  attempts?: number;
  maxAttempts?: number;
  lastAttemptAt?: string;
  failReason?: string;
  retryHistory?: RetryRecord[];
}

export interface RetryRecord {
  attempt: number;
  timestamp: string;
  error: string;
  delay: number;
}

export interface TaskEvent {
  event_type: string;
  task_id: string;
  execution_id: string;
  node_id: string;
  status: string;
  progress?: number;
  message?: string;
  output?: any;
  error?: string;
  timestamp: string;
  attempts?: number;
}

export class TaskQueue {
  private store: typeof memoryStore;
  private prefixes = {
    task: 'task:',
    pending: 'tasks:pending',
    running: 'tasks:running',
    completed: 'tasks:completed',
    events: 'events:task',
  };

  constructor() {
    this.store = memoryStore;
  }

  /**
   * 创建任务
   */
  async createTask(params: {
    executionId: string;
    nodeId: string;
    agentType: string;
    prompt: string;
    parameters?: Record<string, any>;
  }): Promise<Task> {
    const task: Task = {
      id: `task-${randomUUID()}`,
      executionId: params.executionId,
      nodeId: params.nodeId,
      agentType: params.agentType,
      prompt: params.prompt,
      parameters: params.parameters,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await this.store.hset(this.prefixes.task, task.id, JSON.stringify(task));
    await this.store.rpush(this.prefixes.pending, task.id);

    logger.info(`Task created: ${task.id}`, { agentType: params.agentType });
    return task;
  }

  /**
   * 获取任务
   */
  async getTask(taskId: string): Promise<Task | null> {
    const data = await this.store.hget(this.prefixes.task, taskId);
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * 更新任务状态
   */
  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const updatedTask = { ...task, ...updates };
    await this.store.hset(this.prefixes.task, taskId, JSON.stringify(updatedTask));

    await this.publishEvent({
      event_type: 'task.status_changed',
      task_id: taskId,
      execution_id: task.executionId,
      node_id: task.nodeId,
      status: updatedTask.status,
      progress: updatedTask.progress,
      message: updatedTask.message,
      output: updatedTask.output,
      error: updatedTask.error,
      timestamp: new Date().toISOString(),
    });

    return updatedTask;
  }

  /**
   * 获取待处理任务（非阻塞）
   */
  async getPendingTask(): Promise<Task | null> {
    const taskId = await this.store.lpop(this.prefixes.pending);
    if (!taskId) return null;

    return this.claimTask(taskId);
  }

  /**
   * 等待待处理任务（阻塞，BLPOP）
   * @param timeoutSeconds 阻塞超时（秒），0 表示无限等待
   */
  async waitForTask(timeoutSeconds = 5): Promise<Task | null> {
    const result = await this.store.blpop(this.prefixes.pending, timeoutSeconds);
    if (!result) return null;

    const [, taskId] = result;
    return this.claimTask(taskId);
  }

  /**
   * 将任务标记为运行中
   */
  private async claimTask(taskId: string): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (task) {
      await this.store.rpush(this.prefixes.running, taskId);
      await this.updateTask(taskId, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }

    return task;
  }

  /**
   * 完成任务
   */
  async completeTask(taskId: string, output: any): Promise<Task | null> {
    await this.store.lrem(this.prefixes.running, 0, taskId);
    await this.store.rpush(this.prefixes.completed, taskId);

    return this.updateTask(taskId, {
      status: 'succeeded',
      output,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * 任务失败（支持重试）
   */
  async failTask(taskId: string, error: string): Promise<Task | null> {
    await this.store.lrem(this.prefixes.running, 0, taskId);

    const task = await this.getTask(taskId);
    if (!task) return null;

    const attempts = (task.attempts || 0) + 1;
    const maxAttempts = task.maxAttempts || RETRY_CONFIG.maxRetries + 1;

    const retryRecord: RetryRecord = {
      attempt: attempts,
      timestamp: new Date().toISOString(),
      error,
      delay: this.calculateRetryDelay(attempts),
    };

    const retryHistory = [...(task.retryHistory || []), retryRecord];

    if (attempts < maxAttempts) {
      const updatedTask = await this.updateTask(taskId, {
        status: 'retrying',
        attempts,
        error,
        failReason: error,
        retryHistory,
        lastAttemptAt: new Date().toISOString(),
      });

      await this.scheduleRetry(taskId, retryRecord.delay);

      logger.info(`Task ${taskId} scheduled for retry`, { attempts, delay: retryRecord.delay });
      return updatedTask;
    }

    const failedTask = await this.updateTask(taskId, {
      status: 'failed',
      error,
      failReason: error,
      attempts,
      retryHistory,
      completedAt: new Date().toISOString(),
    });

    logger.warn(`Task ${taskId} failed after max retries`, { attempts });
    return failedTask;
  }

  /**
   * 计算重试延迟（指数退避）
   */
  private calculateRetryDelay(attempt: number): number {
    const delay = RETRY_CONFIG.retryDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1);
    return Math.min(delay, RETRY_CONFIG.maxRetryDelay);
  }

  /**
   * 调度重试
   */
  private async scheduleRetry(taskId: string, delay: number): Promise<void> {
    const executeAt = Date.now() + delay;
    await this.store.zadd('tasks:retry', executeAt, taskId);
  }

  /**
   * 获取待重试任务
   */
  async getRetryTask(): Promise<Task | null> {
    const now = Date.now();
    const taskIds = await this.store.zrangebyscore('tasks:retry', 0, now, 'LIMIT', 0, 1);
    
    if (taskIds.length === 0) return null;
    
    const taskId = taskIds[0];
    await this.store.zrem('tasks:retry', taskId);
    
    const task = await this.getTask(taskId);
    if (task && task.status === 'retrying') {
      await this.store.rpush(this.prefixes.running, taskId);
      await this.updateTask(taskId, {
        status: 'running',
        startedAt: new Date().toISOString(),
        message: `重试第 ${task.attempts || 1} 次...`,
      });
    }
    
    return task;
  }

  /**
   * 手动重试任务
   */
  async retryTask(taskId: string): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;
    
    if (task.status !== 'failed' && task.status !== 'retrying') {
      logger.warn(`Cannot retry task ${taskId}`, { status: task.status });
      return null;
    }

    await this.updateTask(taskId, {
      status: 'pending',
      error: undefined,
      message: '等待重试...',
    });

    await this.store.rpush(this.prefixes.pending, taskId);

    logger.info(`Task ${taskId} manually queued for retry`);
    return await this.getTask(taskId);
  }

  /**
   * 发布事件
   */
  private async publishEvent(event: TaskEvent): Promise<void> {
    await this.store.publish(this.prefixes.events, JSON.stringify(event));
  }

  /**
   * 订阅任务事件
   */
  async subscribeEvents(callback: (event: TaskEvent) => void): Promise<void> {
    this.store.subscribe(this.prefixes.events, (message: string) => {
      try {
        const event = JSON.parse(message) as TaskEvent;
        callback(event);
      } catch (error) {
        logger.error('Failed to parse event', { error });
      }
    });
  }

  /**
   * 获取队列统计
   */
  async getStats(): Promise<{
    pending: number;
    running: number;
    completed: number;
  }> {
    const [pending, running, completed] = await Promise.all([
      this.store.llen(this.prefixes.pending),
      this.store.llen(this.prefixes.running),
      this.store.llen(this.prefixes.completed),
    ]);

    return { pending, running, completed };
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    await this.store.quit();
    await this.store.quit();
  }

  /**
   * 获取角色的活跃执行任务
   */
  async getActiveExecutionsByRole(roleId: string): Promise<Array<{
    id: string;
    status: string;
    startTime: Date | null;
    createdAt: Date;
  }>> {
    const executions = await prisma.execution.findMany({
      where: {
        roleId,
        status: { in: ['pending', 'running', 'in_progress'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        startTime: true,
        createdAt: true,
      },
    });

    return executions.map(e => ({
      id: e.id,
      status: e.status,
      startTime: e.startTime,
      createdAt: e.createdAt,
    }));
  }

  /**
   * 检查角色是否有进行中的任务
   */
  async hasActiveTasks(roleId: string): Promise<boolean> {
    const activeExecutions = await this.getActiveExecutionsByRole(roleId);
    return activeExecutions.length > 0;
  }

  /**
   * 获取活跃任务数量
   */
  async getActiveTaskCount(roleId: string): Promise<number> {
    const activeExecutions = await this.getActiveExecutionsByRole(roleId);
    return activeExecutions.length;
  }
}

// 单例实例
export const taskQueue = new TaskQueue();;