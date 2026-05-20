/**
 * Workflow Blocker - Workflow 阻塞/恢复逻辑
 * 
 * 功能：
 * 1. Workflow 阻塞（偏离时）
 * 2. Workflow 恢复（SpecReview approved）
 * 3. Workflow 终止（SpecReview rejected）
 * 4. git stash 管理
 * 
 * WA-009: workflow-blocker.ts（1h）
 */

import type { EventEmitter } from '@dommaker/studio-shared';
import type { TaskQueue } from './task-queue';

/**
 * Redis 客户端接口
 */
export interface WorkflowBlockerRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<'OK'>;
  setex(key: string, seconds: number, value: string): Promise<'OK'>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  lrem(key: string, count: number, value: string): Promise<number>;
  rpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

/**
 * WorkflowBlocker 配置
 */
export interface WorkflowBlockerConfig {
  redis: WorkflowBlockerRedisClient;
  taskQueue: TaskQueue;  // 用于队列管理
  eventEmitter?: EventEmitter;
  ttl?: number;          // 阻塞状态 TTL（默认 24h）
}

const DEFAULT_TTL = 86400;  // 24 hours

/**
 * SpecReview 结果
 */
export interface SpecReviewResult {
  status: 'approved' | 'rejected';
  newDecision?: string;    // 新决策（approved 时）
  reason?: string;         // 拒绝理由（rejected 时）
  newTask?: {              // 新 Task（rejected 时）
    id: string;
    workflowId: string;
  };
}

/**
 * WorkflowBlocker 实现
 */
export class WorkflowBlocker {
  private redis: WorkflowBlockerRedisClient;
  private taskQueue: TaskQueue;
  private eventEmitter?: EventEmitter;
  private ttl: number;

  constructor(config: WorkflowBlockerConfig) {
    this.redis = config.redis;
    this.taskQueue = config.taskQueue;
    this.eventEmitter = config.eventEmitter;
    this.ttl = config.ttl ?? DEFAULT_TTL;
  }

  /**
   * 阻塞 Workflow
   * 
   * 流程：
   * 1. 写入阻塞状态到 Redis
   * 2. 移入 waitingQueue
   * 3. git stash（暂存代码）
   */
  async block(executionId: string, specReviewId: string): Promise<void> {
    const startTime = Date.now();
    
    this.emit('workflow.blocked', { executionId, specReviewId });
    
    // 1. 写入阻塞状态
    const blockedInfo = {
      executionId,
      specReviewId,
      blockedAt: new Date().toISOString(),
      blockedStep: 'unknown',  // 实际应从 ExecutionContext 获取
      stashedCode: null,      // git stash ref（实际应执行 git stash）
    };
    
    await this.redis.setex(
      `workflow:blocked:${executionId}`,
      this.ttl,
      JSON.stringify(blockedInfo)
    );
    
    // 2. 移入 waitingQueue（标记阻塞原因）
    // 实际应调用 taskQueue 的方法
    // 这里简化：写入 waiting 队列
    
    await this.redis.rpush(
      'tasks:waiting',
      JSON.stringify({
        executionId,
        reason: 'spec_review',
        specReviewId,
        blockedAt: new Date().toISOString(),
      })
    );
    
    // 3. git stash（暂存代码）
    // 实际应执行：
    // await exec('git stash push -m "spec-review-${specReviewId}"');
    // 这里简化：记录需要 stash
    
    this.emit('workflow.block_complete', {
      executionId,
      duration: Date.now() - startTime,
    });
  }

  /**
   * 恢复 Workflow
   * 
   * 流程：
   * 1. git stash pop（恢复代码）
   * 2. 从 waitingQueue 移回 runningQueue
   * 3. 更新 baselineDecision
   * 4. 清除阻塞状态
   */
  async resume(executionId: string, result: SpecReviewResult): Promise<void> {
    const startTime = Date.now();
    
    if (result.status !== 'approved') {
      throw new Error('Cannot resume workflow with non-approved result');
    }
    
    this.emit('workflow.resuming', { executionId, result });
    
    // 1. 获取阻塞信息
    const blockedJson = await this.redis.get(`workflow:blocked:${executionId}`);
    
    if (!blockedJson) {
      throw new Error(`Workflow ${executionId} not blocked`);
    }
    
    const blockedInfo = JSON.parse(blockedJson);
    
    // 2. git stash pop（恢复代码）
    // 实际应执行：
    // await exec(`git stash pop ${blockedInfo.stashedCode}`);
    // 这里简化
    
    // 3. 从 waitingQueue 移回 runningQueue
    await this.redis.lrem(
      'tasks:waiting',
      1,
      JSON.stringify({
        executionId,
        reason: 'spec_review',
      })
    );
    
    await this.redis.rpush('tasks:running', executionId);
    
    // 4. 更新 baselineDecision
    if (result.newDecision) {
      await this.redis.set(
        `workflow:baseline:${executionId}`,
        result.newDecision
      );
    }
    
    // 5. 清除阻塞状态
    await this.redis.del(`workflow:blocked:${executionId}`);
    
    this.emit('workflow.resumed', {
      executionId,
      newDecision: result.newDecision,
      duration: Date.now() - startTime,
    });
  }

  /**
   * 终止 Workflow
   * 
   * 流程：
   * 1. git stash drop（丢弃代码）
   * 2. 从 waitingQueue 移除
   * 3. 标记 Workflow 失败
   * 4. 创建新 Task（如果有 newTask）
   */
  async abort(executionId: string, result: SpecReviewResult): Promise<void> {
    const startTime = Date.now();
    
    if (result.status !== 'rejected') {
      throw new Error('Cannot abort workflow with non-rejected result');
    }
    
    this.emit('workflow.aborting', { executionId, result });
    
    // 1. 获取阻塞信息
    const blockedJson = await this.redis.get(`workflow:blocked:${executionId}`);
    
    // 2. git stash drop（丢弃代码）
    // 实际应执行：
    // await exec('git stash drop');
    // 这里简化
    
    // 3. 从 waitingQueue 移除
    if (blockedJson) {
      await this.redis.lrem(
        'tasks:waiting',
        1,
        JSON.stringify({
          executionId,
          reason: 'spec_review',
        })
      );
    }
    
    // 4. 标记 Workflow 失败
    await this.redis.set(
      `workflow:failed:${executionId}`,
      JSON.stringify({
        executionId,
        reason: result.reason,
        failedAt: new Date().toISOString(),
      })
    );
    
    // 5. 创建新 Task（如果有 newTask）
    if (result.newTask) {
      await this.redis.set(
        `task:new:${executionId}`,
        JSON.stringify(result.newTask)
      );
      
      // 入队到 pending
      await this.redis.rpush(
        'tasks:pending',
        JSON.stringify({
          id: result.newTask.id,
          workflowId: result.newTask.workflowId,
          status: 'pending',
          waitFor: [],
        })
      );
    }
    
    // 6. 清除阻塞状态
    if (blockedJson) {
      await this.redis.del(`workflow:blocked:${executionId}`);
    }
    
    this.emit('workflow.aborted', {
      executionId,
      reason: result.reason,
      newTask: result.newTask,
      duration: Date.now() - startTime,
    });
  }

  /**
   * 获取阻塞信息
   */
  async getBlockedInfo(executionId: string): Promise<any | null> {
    const blockedJson = await this.redis.get(`workflow:blocked:${executionId}`);
    
    if (!blockedJson) return null;
    
    return JSON.parse(blockedJson);
  }

  /**
   * 检查是否阻塞
   */
  async isBlocked(executionId: string): Promise<boolean> {
    const blocked = await this.redis.get(`workflow:blocked:${executionId}`);
    return blocked !== null;
  }

  /**
   * 发送事件
   */
  private emit(event: string, data: any): void {
    this.eventEmitter?.emit(event as any, data);
  }
}

/**
 * 创建 WorkflowBlocker
 */
export function createWorkflowBlocker(config: WorkflowBlockerConfig): WorkflowBlocker {
  return new WorkflowBlocker(config);
}