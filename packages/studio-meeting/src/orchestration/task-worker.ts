/**
 * TaskWorker - Task 消费 + 并发检查
 * 
 * 功能：
 * 1. 从 pendingQueue 取 Task
 * 2. 执行并发检查（全局 + Agent 类型）
 * 3. 执行依赖检查
 * 4. 调用 TaskQueue.enqueue 处理入队
 * 
 * WA-002: TaskWorker 并发检查（0.5h）
 */

import type { TaskQueue } from './task-queue';
import type { EventEmitter } from '@dommaker/studio-shared';

/**
 * Redis 客户端接口（TaskWorker 需要）
 */
export interface TaskWorkerRedisClient {
  lpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
}

/**
 * TaskWorker 配置
 */
export interface TaskWorkerConfig {
  queue: TaskQueue;
  redis: TaskWorkerRedisClient;
  checkInterval?: number;        // 检查间隔（默认 5000ms）
  eventEmitter?: EventEmitter;
}

const DEFAULT_CHECK_INTERVAL = 5000;
const PENDING_QUEUE = 'tasks:pending';

/**
 * Task 结构
 */
interface Task {
  id: string;
  name: string;
  agentType: string;
  workflowId: string;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed';
  waitFor: string[];
}

/**
 * TaskWorker 实现
 */
export class TaskWorker {
  private queue: TaskQueue;
  private redis: TaskWorkerRedisClient;
  private checkInterval: number;
  private eventEmitter?: EventEmitter;
  private running: boolean = false;
  private intervalId?: NodeJS.Timeout;

  constructor(config: TaskWorkerConfig) {
    this.queue = config.queue;
    this.redis = config.redis;
    this.checkInterval = config.checkInterval ?? DEFAULT_CHECK_INTERVAL;
    this.eventEmitter = config.eventEmitter;
  }

  /**
   * 启动 Worker
   */
  start(): void {
    if (this.running) return;
    
    this.running = true;
    this.emit('worker.started', {});
    
    // 启动轮询
    this.intervalId = setInterval(() => {
      this.poll().catch(err => {
        console.error('TaskWorker poll error:', err);
      });
    }, this.checkInterval);
    
    // 立即执行一次
    this.poll().catch(err => {
      console.error('TaskWorker initial poll error:', err);
    });
  }

  /**
   * 停止 Worker
   */
  stop(): void {
    if (!this.running) return;
    
    this.running = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    
    this.emit('worker.stopped', {});
  }

  /**
   * 轮询 pendingQueue
   */
  private async poll(): Promise<void> {
    while (this.running) {
      // 从 pendingQueue 取 Task
      const taskJson = await this.redis.lpop(PENDING_QUEUE);
      
      if (!taskJson) {
        // 无 Task，退出本轮
        break;
      }
      
      // 解析 Task
      const task: Task = JSON.parse(taskJson);
      
      this.emit('worker.task_received', { taskId: task.id });
      
      // 调用 queue.enqueue 处理入队
      // queue.enqueue 会自动检查：
      // 1. 全局并发
      // 2. Agent 类型并发
      // 3. 依赖
      // 并决定放入 running 还是 waiting
      await this.queue.enqueue(task);
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
 * 创建 TaskWorker
 */
export function createTaskWorker(config: TaskWorkerConfig): TaskWorker {
  return new TaskWorker(config);
}