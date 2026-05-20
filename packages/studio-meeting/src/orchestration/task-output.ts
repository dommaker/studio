/**
 * TaskOutput 封装 - 跨 Task 上下文存储
 * 
 * 功能：
 * 1. TaskOutput 存储到 Redis
 * 2. 批量获取依赖 Task 输出
 * 3. 提取关键数据
 * 
 * WA-006: TaskOutput 封装（0.5h）
 */

import type { TaskQueueRedisClient } from './task-queue';

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
 * TaskOutput 配置
 */
export interface TaskOutputConfig {
  redis: TaskQueueRedisClient;
  ttl?: number;              // 默认 3600s
}

const DEFAULT_TTL = 3600;

/**
 * TaskOutput Key 前缀
 */
const OUTPUT_KEY_PREFIX = 'task:output:';

/**
 * TaskOutput 管理器
 */
export class TaskOutputManager {
  private redis: TaskQueueRedisClient;
  private ttl: number;

  constructor(config: TaskOutputConfig) {
    this.redis = config.redis;
    this.ttl = config.ttl ?? DEFAULT_TTL;
  }

  /**
   * 保存 TaskOutput
   */
  async save(taskId: string, output: TaskOutput): Promise<void> {
    const key = `${OUTPUT_KEY_PREFIX}${taskId}`;
    
    await this.redis.setex(key, this.ttl, JSON.stringify(output));
  }

  /**
   * 获取单个 TaskOutput
   */
  async get(taskId: string): Promise<TaskOutput | null> {
    const key = `${OUTPUT_KEY_PREFIX}${taskId}`;
    const outputJson = await this.redis.get(key);
    
    if (!outputJson) return null;
    
    return JSON.parse(outputJson);
  }

  /**
   * 批量获取依赖 Task 输出
   */
  async getDependentOutputs(dependencies: string[]): Promise<Record<string, TaskOutput>> {
    const outputs: Record<string, TaskOutput> = {};

    for (const depId of dependencies) {
      const output = await this.get(depId);
      
      if (output) {
        outputs[depId] = output;
      }
    }

    return outputs;
  }

  /**
   * 构建依赖输出上下文（用于 prompt）
   */
  async buildDependentContext(dependencies: string[]): Promise<string> {
    const outputs = await this.getDependentOutputs(dependencies);
    
    if (Object.keys(outputs).length === 0) {
      return '';
    }

    const parts: string[] = [
      '## 📋 依赖 Task 输出',
      '',
    ];

    for (const [taskId, output] of Object.entries(outputs)) {
      parts.push(`### Task: ${taskId}`);
      parts.push('');
      
      // 关键数据
      if (output.keyData) {
        parts.push('**关键数据**：');
        parts.push(formatKeyData(output.keyData));
        parts.push('');
      }
      
      // 摘要
      if (output.summary) {
        parts.push(`**摘要**: ${output.summary}`);
        parts.push('');
      }
      
      parts.push('---');
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * 删除 TaskOutput
   */
  async delete(taskId: string): Promise<void> {
    const key = `${OUTPUT_KEY_PREFIX}${taskId}`;
    await this.redis.del(key);
  }

  /**
   * 刷新 TTL
   */
  async refreshTTL(taskId: string, newTTL?: number): Promise<void> {
    const key = `${OUTPUT_KEY_PREFIX}${taskId}`;
    await this.redis.expire(key, newTTL ?? this.ttl);
  }
}

/**
 * 格式化关键数据
 */
function formatKeyData(keyData: any): string {
  if (!keyData || typeof keyData !== 'object') {
    return String(keyData);
  }

  const lines: string[] = [];

  for (const [key, value] of Object.entries(keyData)) {
    if (Array.isArray(value)) {
      lines.push(`- ${key}: ${value.join(', ')}`);
    } else if (typeof value === 'object') {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines.join('\n');
}

/**
 * 创建 TaskOutputManager
 */
export function createTaskOutputManager(config: TaskOutputConfig): TaskOutputManager {
  return new TaskOutputManager(config);
}