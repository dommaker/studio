/**
 * TaskWorker - 任务队列消费者
 *
 * 消费任务队列并执行，通过 HTTP API 调用 agent-runtime
 * 微服务友好：无本地依赖，可部署到任何服务
 *
 * 支持 Redis 订阅（无需轮询）+ fallback 轮询
 */

import { TaskQueue, Task } from './task-queue';
import { randomUUID } from 'crypto';
// @ts-ignore — node-fetch v2 type declarations not in deps
import fetch from "node-fetch";
import { logger, memoryStore } from '@dommaker/studio-shared';

// 执行超时常量
const EXECUTION_MAX_WAIT_MS = 30 * 60 * 1000; // 30 分钟
const EXECUTION_CHECK_INTERVAL_MS = 2000; // 2 秒
const FALLBACK_POLL_DELAY_MS = 60_000; // 1 分钟后开始 fallback 轮询

export interface WorkerConfig {
  concurrency?: number;
  pollInterval?: number;
  enableRetry?: boolean;
  agentRuntimeUrl?: string;
  enableRedisSubscription?: boolean;  // 🆕 是否启用 Redis 订阅
}

interface ExecutionProgress {
  runtimeExecutionId: string;
  studioExecutionId: string;
  status: 'running' | 'completed' | 'failed';
  steps: any[];
  outputs?: any;
  error?: string;
}

export class TaskWorker {
  private running = false;
  private concurrency: number;
  private pollInterval: number;
  private enableRetry: boolean;
  private enableRedisSubscription: boolean;
  private activeTasks = new Map<string, Promise<void>>();
  private executionProgress = new Map<string, ExecutionProgress>();  // 🆕 存储执行进度
  private redis: typeof memoryStore;
  private agentRuntimeUrl: string;
  private taskQueue: TaskQueue;

  constructor(config: WorkerConfig = {}) {
    this.concurrency = config.concurrency || 1;
    this.pollInterval = config.pollInterval || 1000;
    this.enableRetry = config.enableRetry ?? true;
    this.enableRedisSubscription = config.enableRedisSubscription ?? true;
    this.redis = memoryStore;
    this.agentRuntimeUrl = config.agentRuntimeUrl || process.env.AGENT_RUNTIME_URL || 'http://localhost:3001';
    this.taskQueue = new TaskQueue();
  }

  /**
   * 启动 Worker
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 🆕 从 Redis 读取配置
    try {
      const configStr = await this.redis.get('studio:worker:config');
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.maxConcurrent) {
          this.concurrency = config.maxConcurrent;
          logger.info('Loaded concurrency from Redis', { maxConcurrent: this.concurrency });
        }
      }
    } catch (err) {
      logger.warn('Failed to load config from Redis, using default', { error: String(err) });
    }
    
    // 🆕 监听 events channel（接收 runtime 推送的进度）
    if (this.enableRedisSubscription) {
      try {
        this.redis.subscribe('events', (message) => {
          this.handleProgressEvent(message);
        });
        this.redis.subscribe('studio:worker:reload', () => {
          this.reloadConfig();
        });
        logger.info('Subscribed to events channel');
      } catch (err) {
        logger.warn('Failed to subscribe to events, fallback to polling', { error: String(err) });
      }
    }
    
    logger.info("Task worker started", {
      concurrency: this.concurrency,
      agentRuntimeUrl: this.agentRuntimeUrl,
      redisSubscription: this.enableRedisSubscription,
    });

    this.poll();
  }
  
  /**
   * 🆕 处理进度事件（来自 Redis）
   */
  private handleProgressEvent(messageStr: string): void {
    try {
      const event = JSON.parse(messageStr);
      const eventType = event.event_type || '';
      
      // 只处理 runtime 事件
      if (!eventType.includes('runtime.') && !eventType.includes('workflow.')) {
        return;
      }
      
      const data = event.data || {};
      const runtimeExecutionId = data.executionId || event.executionId;
      
      logger.debug('Received runtime event', { eventType, runtimeExecutionId });
      
      // 查找对应的 studio execution
      const studioExecutionId = this.findStudioExecution(runtimeExecutionId);
      if (!studioExecutionId) {
        return;
      }
      
      // 更新进度存储
      const progress: ExecutionProgress = this.executionProgress.get(runtimeExecutionId) || {
        runtimeExecutionId,
        studioExecutionId,
        status: 'running',
        steps: [],
      };
      
      // 处理不同事件类型
      if (eventType.includes('completed')) {
        progress.status = 'completed';
        progress.outputs = data.outputs;
      } else if (eventType.includes('failed')) {
        progress.status = 'failed';
        progress.error = data.error || data.message;
      } else if (eventType.includes('progress')) {
        // 更新步骤进度
        if (data.steps) {
          progress.steps = data.steps;
        }
      }
      
      this.executionProgress.set(runtimeExecutionId, progress);
      
      // 发送思考流事件（给前端）
      this.publishThinkingStream(studioExecutionId, {
        type: 'step_progress',
        progress: data.progress,
        steps: data.steps,
      });
      
    } catch (err) {
      logger.warn('Failed to handle progress event', { error: String(err) });
    }
  }
  
  /**
   * 🆕 查找 studio execution（通过 runtime executionId）
   */
  private findStudioExecution(runtimeExecutionId: string): string | null {
    // 从 executionProgress map 查找
    const progress = this.executionProgress.get(runtimeExecutionId);
    if (progress) {
      return progress.studioExecutionId;
    }
    return null;
  }
  
  /**
   * 🆕 重载配置（热更新）
   */
  private async reloadConfig(): Promise<void> {
    try {
      const configStr = await this.redis.get('studio:worker:config');
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.maxConcurrent && config.maxConcurrent !== this.concurrency) {
          const oldConcurrency = this.concurrency;
          this.concurrency = config.maxConcurrent;
          logger.info('Config reloaded', { 
            oldConcurrency, 
            newConcurrency: this.concurrency,
            activeTasks: this.activeTasks.size,
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to reload config', { error: String(err) });
    }
  }

  /**
   * 停止 Worker
   */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(Array.from(this.activeTasks.values()));
    logger.info('Task worker stopped');
  }

  /**
   * 消费任务队列（BLPOP 阻塞等待，事件驱动）
   */
  private async poll(): Promise<void> {
    while (this.running) {
      try {
        // 并发已满时等待一个任务完成后再继续
        if (this.activeTasks.size >= this.concurrency) {
          await Promise.race(Array.from(this.activeTasks.values()));
          continue;
        }

        // 先检查重试队列（非阻塞）
        if (this.enableRetry) {
          const retryTask = await this.taskQueue.getRetryTask();
          if (retryTask) {
            this.launchTask(retryTask);
            continue;
          }
        }

        // 阻塞等待新任务（Redis BLPOP，超时后重新检查 running 状态）
        const task = await this.taskQueue.waitForTask(5);
        if (task) {
          this.launchTask(task);
        }
      } catch (error) {
        logger.error('Error in task loop', { error: String(error) });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * 启动任务执行（非阻塞）
   */
  private launchTask(task: Task): void {
    const taskPromise = this.executeTask(task);
    this.activeTasks.set(task.id, taskPromise);
    taskPromise.finally(() => {
      this.activeTasks.delete(task.id);
    });
  }

  /**
   * 执行任务
   */
  private async executeTask(task: Task): Promise<void> {
    const attempt = task.attempts || 0;
    logger.info(`Executing task ${task.id}`, { agentType: task.agentType, attempt: attempt + 1 });

    try {
      const prompt = this.buildPrompt(task, attempt);
      const result = await this.runAgent({ ...task, prompt });
      
      await this.taskQueue.completeTask(task.id, result);
      logger.info(`Task ${task.id} completed successfully`, { attempt: attempt + 1 });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.error(`Task ${task.id} failed`, { attempt: attempt + 1, error: errorMessage });
      
      await this.taskQueue.failTask(task.id, errorMessage);
    }
  }

  /**
   * 构建 Prompt（支持智能重试）
   */
  private buildPrompt(task: Task, attempt: number): string {
    if (attempt === 0) {
      return task.prompt;
    }

    const retryHistory = task.retryHistory || [];
    const lastError = retryHistory[retryHistory.length - 1]?.error || '未知错误';

    return `之前的尝试失败了，原因：${lastError}

请分析失败原因并调整策略，重新完成任务。

原始需求：
${task.prompt}

请：
1. 分析失败原因
2. 制定新的解决方案
3. 重新实现

注意：不要重复之前的错误。`;
  }

  /**
   * 执行 Agent 任务（通过 HTTP API）
   */
  private async runAgent(task: Task): Promise<any> {
    // 调用 agent-runtime HTTP API
    const response = await fetch(`${this.agentRuntimeUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow: task.parameters?.workflow || 'wf-solo',
        inputs: { requirement: task.prompt },
        workdir: task.parameters?.workdir,
        options: {
          retry: 'smart',
          useCache: true,
        }
      })
    });

    if (!response.ok) {
      throw new Error(`agent-runtime API error: ${response.status}`);
    }

    const result = await response.json() as any;
    const runtimeExecutionId = result.executionId;
    const studioExecutionId = task.executionId || randomUUID();

    // 注册到 executionProgress（用于 Redis 订阅匹配）
    this.executionProgress.set(runtimeExecutionId, {
      runtimeExecutionId,
      studioExecutionId,
      status: 'running',
      steps: [],
    });

    // 等待完成（通过 Redis 事件 或 fallback 轮询）
    return await this.waitForCompletion(runtimeExecutionId, studioExecutionId);
  }
  
  /**
   * 🆕 等待执行完成（Redis 事件优先，fallback 轮询）
   */
  private async waitForCompletion(runtimeExecutionId: string, studioExecutionId: string): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < EXECUTION_MAX_WAIT_MS) {
      // 检查 executionProgress（由 Redis 事件更新）
      const progress = this.executionProgress.get(runtimeExecutionId);
      
      if (progress) {
        if (progress.status === 'completed') {
          // 清理
          this.executionProgress.delete(runtimeExecutionId);
          return {
            success: true,
            outputs: progress.outputs,
            verifyStatus: 'passed',
          };
        }
        
        if (progress.status === 'failed') {
          this.executionProgress.delete(runtimeExecutionId);
          return {
            success: false,
            error: progress.error,
            verifyStatus: 'failed',
          };
        }
      }
      
      // Fallback: 如果 Redis 事件未到达，定期轮询 HTTP API
      if (!this.enableRedisSubscription || !progress || Date.now() - startTime > FALLBACK_POLL_DELAY_MS) {
        // 1 分钟后开始 fallback 轮询
        const statusResult = await this.pollExecutionStatusOnce(runtimeExecutionId, studioExecutionId);
        if (statusResult.completed) {
          return statusResult.result;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, EXECUTION_CHECK_INTERVAL_MS));
    }

    // 超时
    this.executionProgress.delete(runtimeExecutionId);
    return {
      success: false,
      error: 'Execution timeout',
      verifyStatus: 'timeout',
    };
  }
  
  /**
   * 🆕 单次轮询（fallback）
   */
  private async pollExecutionStatusOnce(runtimeExecutionId: string, studioExecutionId: string): Promise<{
    completed: boolean;
    result?: any;
  }> {
    try {
      const response = await fetch(`${this.agentRuntimeUrl}/api/status/${runtimeExecutionId}`);
      if (!response.ok) {
        return { completed: false };
      }
      
      const status = await response.json() as any;
      
      // 发送步骤事件
      if (status.progress?.steps) {
        this.publishStepEvent(studioExecutionId, status.progress.steps);
      }
      
      if (status.status === 'completed') {
        return {
          completed: true,
          result: {
            success: true,
            outputs: status.outputs,
            verifyStatus: status.verifyStatus || 'passed',
          },
        };
      }
      
      if (status.status === 'failed') {
        return {
          completed: true,
          result: {
            success: false,
            error: status.error || status.message,
            verifyStatus: 'failed',
          },
        };
      }
      
      return { completed: false };
    } catch (err) {
      logger.warn('Fallback poll failed', { error: String(err) });
      return { completed: false };
    }
  }

  /**
   * 获取 Worker 状态
   */
  getStatus(): {
    running: boolean;
    activeTasks: number;
    maxConcurrency: number;
    agentRuntimeUrl: string;
    redisSubscription: boolean;
    pendingExecutions: number;
  } {
    return {
      running: this.running,
      activeTasks: this.activeTasks.size,
      maxConcurrency: this.concurrency,
      agentRuntimeUrl: this.agentRuntimeUrl,
      redisSubscription: this.enableRedisSubscription,
      pendingExecutions: this.executionProgress.size,
    };
  }

  /**
   * 发布思考流事件
   */
  private async publishThinkingStream(executionId: string, data: {
    type: 'step_start' | 'step_progress' | 'step_output' | 'step_complete' | 'thinking' | 'action';
    stepId?: string;
    stepName?: string;
    content?: string;
    progress?: number;
    steps?: any[];
  }): Promise<void> {
    const event = {
      event_id: randomUUID(),
      event_type: 'thinking.stream',
      timestamp: new Date().toISOString(),
      data: {
        executionId,
        ...data,
      },
    };
    
    await this.redis.publish('events', JSON.stringify(event));
  }

  /**
   * 发布步骤状态事件
   */
  private async publishStepEvent(executionId: string, steps: any[]): Promise<void> {
    for (const step of steps) {
      const event = {
        event_id: randomUUID(),
        event_type: `pipeline.step_${step.status}`,
        timestamp: new Date().toISOString(),
        data: {
          executionId,
          stepId: step.id,
          stepName: step.name,
          output: step.output,
        },
      };
      
      await this.redis.publish('events', JSON.stringify(event));
    }
  }
}

// 单例实例
export const taskWorker = new TaskWorker();