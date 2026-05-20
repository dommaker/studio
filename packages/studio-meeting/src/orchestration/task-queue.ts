/**
 * TaskQueue - Task 队列管理
 * 
 * 功能：
 * 1. Redis 队列管理（pending/running/waiting/completed）
 * 2. 并发控制（maxConcurrency + perTypeConcurrency）
 * 3. 依赖检查
 * 4. TaskOutput 存储
 * 
 * WA-001: TaskQueue 封装（0.5h）
 */

import type { EventEmitter } from '@dommaker/studio-shared';

/**
 * Redis 客户端接口（扩展 list 操作）
 */
export interface TaskQueueRedisClient {
  // List operations
  lpush(key: string, value: string): Promise<number>;
  rpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  lpos(key: string, value: string): Promise<number | null>;
  
  // String operations
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<'OK'>;
  setex(key: string, seconds: number, value: string): Promise<'OK'>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  
  // Counter operations
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
}

/**
 * Task 结构
 */
export interface Task {
  id: string;
  name: string;
  agentType: string;         // 'codex' | 'claude'
  workflowId: string;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed';
  waitFor: string[];         // 依赖 Task IDs
  baselineDecision?: string; // Contract baseline
  contract?: any;            // Contract specification
}

/**
 * TaskOutput 结构
 */
export interface TaskOutput {
  taskId: string;
  workflowId: string;
  agentType: string;
  keyData: any;              // 提取的关键数据
  summary: string;           // 输出摘要
  completedAt: string;
  ttl: number;               // 3600s
}

/**
 * TaskQueue 配置
 */
export interface TaskQueueConfig {
  redis: TaskQueueRedisClient;
  maxConcurrency?: number;           // 全局并发限制（默认 2）
  perTypeConcurrency?: number;       // Agent 类型限制（默认 1）
  outputTTL?: number;                // TaskOutput TTL（默认 3600s）
  eventEmitter?: EventEmitter;
}

// 默认配置
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_PER_TYPE_CONCURRENCY = 1;
const DEFAULT_OUTPUT_TTL = 3600;

// 队列 Key
const QUEUE_KEYS = {
  pending: 'tasks:pending',
  running: 'tasks:running',
  waiting: 'tasks:waiting',
  completed: 'tasks:completed',
  failed: 'tasks:failed',
  typeCount: (type: string) => `tasks:type:${type}:running`,
  output: (taskId: string) => `task:output:${taskId}`,
  blocked: (executionId: string) => `workflow:blocked:${executionId}`,
};

/**
 * TaskQueue 实现
 */
export class TaskQueue {
  private redis: TaskQueueRedisClient;
  private maxConcurrency: number;
  private perTypeConcurrency: number;
  private outputTTL: number;
  private eventEmitter?: EventEmitter;

  constructor(config: TaskQueueConfig) {
    this.redis = config.redis;
    this.maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.perTypeConcurrency = config.perTypeConcurrency ?? DEFAULT_PER_TYPE_CONCURRENCY;
    this.outputTTL = config.outputTTL ?? DEFAULT_OUTPUT_TTL;
    this.eventEmitter = config.eventEmitter;
  }

  /**
   * Task 入队
   * 
   * 流程：
   * 1. 检查全局并发
   * 2. 检查 Agent 类型并发
   * 3. 检查依赖
   * 4. 决定队列：running / waiting
   */
  async enqueue(task: Task): Promise<void> {
    const startTime = Date.now();

    this.emit('task.enqueued', { taskId: task.id, status: task.status });

    // 检查依赖
    const dependenciesMet = await this.checkDependencies(task.waitFor);
    
    if (!dependenciesMet) {
      // 依赖未满足 → waiting
      await this.addToWaiting(task);
      this.emit('task.waiting', { taskId: task.id, reason: 'dependencies_not_met' });
      return;
    }

    // 检查全局并发
    const runningCount = await this.getRunningCount();
    
    if (runningCount >= this.maxConcurrency) {
      // 全局并发满 → waiting
      await this.addToWaiting(task);
      this.emit('task.waiting', { taskId: task.id, reason: 'max_concurrency_reached' });
      return;
    }

    // 检查 Agent 类型并发
    const typeCount = await this.getTypeCount(task.agentType);
    
    if (typeCount >= this.perTypeConcurrency) {
      // 类型并发满 → waiting
      await this.addToWaiting(task);
      this.emit('task.waiting', { taskId: task.id, reason: 'type_concurrency_reached', agentType: task.agentType });
      return;
    }

    // 可以运行 → running
    await this.addToRunning(task);
    this.emit('task.running', { taskId: task.id, agentType: task.agentType });
  }

  /**
   * Task 完成
   * 
   * 流程：
   * 1. 从 running 移除
   * 2. Agent 类型计数减 1
   * 3. 保存 TaskOutput
   * 4. 通知依赖 Task
   * 5. 检查 waiting 队列，移动就绪 Task
   */
  async complete(taskId: string, output?: any): Promise<void> {
    // 获取 Task 信息
    const task = await this.getTask(taskId);
    
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 从 running 移除
    await this.redis.lrem(QUEUE_KEYS.running, 1, taskId);
    
    // Agent 类型计数减 1
    await this.redis.decr(QUEUE_KEYS.typeCount(task.agentType));

    // 添加到 completed
    await this.redis.rpush(QUEUE_KEYS.completed, taskId);

    // 保存 TaskOutput
    if (output) {
      await this.saveOutput(taskId, task, output);
    }

    this.emit('task.completed', { taskId, duration: Date.now() - Date.now() });

    // 通知依赖 Task
    await this.notifyDependentTasks(taskId);
    
    // 检查 waiting 队列
    await this.checkWaitingQueue();
  }

  /**
   * Task 失败
   */
  async fail(taskId: string, error: string): Promise<void> {
    const task = await this.getTask(taskId);
    
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 从 running 移除
    await this.redis.lrem(QUEUE_KEYS.running, 1, taskId);
    
    // Agent 类型计数减 1
    await this.redis.decr(QUEUE_KEYS.typeCount(task.agentType));

    // 添加到 failed
    await this.redis.rpush(QUEUE_KEYS.failed, JSON.stringify({ taskId, error }));

    this.emit('task.failed', { taskId, error });

    // 检查 waiting 队列
    await this.checkWaitingQueue();
  }

  /**
   * 检查依赖是否满足
   */
  async checkDependencies(dependencies: string[]): Promise<boolean> {
    if (dependencies.length === 0) return true;

    for (const depId of dependencies) {
      const completed = await this.redis.lpos(QUEUE_KEYS.completed, depId);
      if (completed === null) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取就绪 Task
   */
  async getReadyTasks(): Promise<Task[]> {
    const waiting = await this.redis.lrange(QUEUE_KEYS.waiting, 0, -1);
    const readyTasks: Task[] = [];

    for (const taskJson of waiting) {
      const task: Task = JSON.parse(taskJson);
      
      // 检查依赖
      const dependenciesMet = await this.checkDependencies(task.waitFor);
      
      // 检查并发
      const runningCount = await this.getRunningCount();
      const typeCount = await this.getTypeCount(task.agentType);
      
      if (dependenciesMet && 
          runningCount < this.maxConcurrency && 
          typeCount < this.perTypeConcurrency) {
        readyTasks.push(task);
      }
    }

    return readyTasks;
  }

  /**
   * 获取 TaskOutput
   */
  async getOutput(taskId: string): Promise<TaskOutput | null> {
    const outputJson = await this.redis.get(QUEUE_KEYS.output(taskId));
    
    if (!outputJson) return null;
    
    return JSON.parse(outputJson);
  }

  /**
   * 获取运行数量
   */
  async getRunningCount(): Promise<number> {
    return this.redis.llen(QUEUE_KEYS.running);
  }

  /**
   * 获取等待数量
   */
  async getWaitingCount(): Promise<number> {
    return this.redis.llen(QUEUE_KEYS.waiting);
  }

  /**
   * 获取 Agent 类型计数
   */
  async getTypeCount(agentType: string): Promise<number> {
    const count = await this.redis.get(QUEUE_KEYS.typeCount(agentType));
    return parseInt(count ?? '0', 10);
  }

  // ========== Private Methods ==========

  /**
   * 添加到 running 队列
   */
  private async addToRunning(task: Task): Promise<void> {
    await this.redis.rpush(QUEUE_KEYS.running, task.id);
    await this.redis.incr(QUEUE_KEYS.typeCount(task.agentType));
    
    // 保存 Task 元数据（用于后续获取）
    await this.redis.setex(`task:meta:${task.id}`, 3600, JSON.stringify(task));
  }

  /**
   * 添加到 waiting 队列
   */
  private async addToWaiting(task: Task): Promise<void> {
    task.status = 'waiting';
    await this.redis.rpush(QUEUE_KEYS.waiting, JSON.stringify(task));
  }

  /**
   * 获取 Task 元数据
   */
  private async getTask(taskId: string): Promise<Task | null> {
    const taskJson = await this.redis.get(`task:meta:${taskId}`);
    
    if (!taskJson) return null;
    
    return JSON.parse(taskJson);
  }

  /**
   * 保存 TaskOutput
   */
  private async saveOutput(taskId: string, task: Task, output: any): Promise<void> {
    const taskOutput: TaskOutput = {
      taskId,
      workflowId: task.workflowId,
      agentType: task.agentType,
      keyData: this.extractKeyData(output),
      summary: this.summarizeOutput(output),
      completedAt: new Date().toISOString(),
      ttl: this.outputTTL,
    };

    await this.redis.setex(
      QUEUE_KEYS.output(taskId),
      this.outputTTL,
      JSON.stringify(taskOutput)
    );
  }

  /**
   * 提取关键数据
   */
  private extractKeyData(output: any): any {
    if (!output || typeof output !== 'object') return output;

    // 提取关键字段
    const keyFields = ['techStack', 'decisions', 'completed', 'files', 'result'];
    const keyData: any = {};

    for (const field of keyFields) {
      if (output[field]) {
        keyData[field] = output[field];
      }
    }

    return keyData;
  }

  /**
   * 生成摘要
   */
  private summarizeOutput(output: any): string {
    if (!output) return '';

    if (typeof output === 'string') {
      return output.slice(0, 200);
    }

    if (typeof output === 'object') {
      const summaryParts: string[] = [];

      if (output.result) summaryParts.push(`result: ${output.result}`);
      if (output.files) summaryParts.push(`files: ${output.files.length}`);
      if (output.decisions) summaryParts.push(`decisions: ${output.decisions.length}`);

      return summaryParts.join(', ') || JSON.stringify(output).slice(0, 200);
    }

    return String(output).slice(0, 200);
  }

  /**
   * 通知依赖 Task
   */
  private async notifyDependentTasks(completedTaskId: string): Promise<void> {
    const waiting = await this.redis.lrange(QUEUE_KEYS.waiting, 0, -1);

    for (const taskJson of waiting) {
      const task: Task = JSON.parse(taskJson);

      if (task.waitFor?.includes(completedTaskId)) {
        // 检查是否所有依赖都完成
        const allCompleted = await this.checkDependencies(task.waitFor);

        if (allCompleted) {
          // 从 waiting 移除
          await this.redis.lrem(QUEUE_KEYS.waiting, 1, taskJson);
          
          // 重新入队（检查并发）
          task.status = 'pending';
          await this.enqueue(task);
        }
      }
    }
  }

  /**
   * 检查 waiting 队列
   */
  private async checkWaitingQueue(): Promise<void> {
    const readyTasks = await this.getReadyTasks();

    for (const task of readyTasks) {
      // 从 waiting 移除
      const waiting = await this.redis.lrange(QUEUE_KEYS.waiting, 0, -1);
      const taskJson = waiting.find(t => JSON.parse(t).id === task.id);
      
      if (taskJson) {
        await this.redis.lrem(QUEUE_KEYS.waiting, 1, taskJson);
        
        // 入队
        task.status = 'pending';
        await this.enqueue(task);
      }
    }
  }

  /**
   * 发送事件
   */
  private emit(event: string, data: any): void {
    this.eventEmitter?.emit(event as any, data);
  }
}

/**
 * 创建 TaskQueue
 */
export function createTaskQueue(config: TaskQueueConfig): TaskQueue {
  return new TaskQueue(config);
}