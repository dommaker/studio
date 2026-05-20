/**
 * 上下文共享模块
 * 
 * 功能：
 * 1. Redis 存储共享上下文（跨进程）
 * 2. 支持按执行 ID 隔离
 * 3. TTL 自动清理
 * 4. 大对象分片存储
 * 
 * 复用：
 * - Redis 连接：复用现有 redis 实例
 * - 事件通知：复用 EventEmitter
 */

import { EventEmitter } from '@dommaker/studio-shared';

/**
 * Redis 客户端接口（最小化依赖）
 */
export interface RedisClient {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<number>;
  hexists(key: string, field: string): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  // 基础字符串操作（用于混合存储方案）
  get?(key: string): Promise<string | null>;
  setex?(key: string, seconds: number, value: string): Promise<'OK' | null>;
}

/**
 * 共享上下文条目
 */
export interface SharedContext {
  key: string;
  value: any;
  type: 'string' | 'object' | 'buffer';
  size: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string; // 角色 ID
}

/**
 * 上下文共享配置
 */
export interface ContextSharerConfig {
  redis: RedisClient;
  executionId: string;
  ttl?: number; // 秒，默认 3600（1小时）
  maxSize?: number; // 单条最大字节，默认 1MB
  eventEmitter?: EventEmitter;
}

// 默认配置
const DEFAULT_TTL = 3600; // 1 小时
const DEFAULT_MAX_SIZE = 1024 * 1024; // 1 MB

/**
 * 上下文共享器
 */
export class ContextSharer {
  private redis: RedisClient;
  private executionId: string;
  private ttl: number;
  private maxSize: number;
  private eventEmitter?: EventEmitter;
  private keyPrefix: string;
  
  constructor(config: ContextSharerConfig) {
    this.redis = config.redis;
    this.executionId = config.executionId;
    this.ttl = config.ttl ?? DEFAULT_TTL;
    this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
    this.eventEmitter = config.eventEmitter;
    this.keyPrefix = `orchestration:${config.executionId}:context`;
  }
  
  /**
   * 设置上下文
   */
  async set(key: string, value: any, createdBy?: string): Promise<void> {
    const fullKey = `${this.keyPrefix}:${key}`;
    
    // 序列化
    const serialized = this.serialize(value);
    
    // 检查大小
    if (serialized.size > this.maxSize) {
      throw new Error(`Context value too large: ${serialized.size} bytes (max: ${this.maxSize})`);
    }
    
    // 构建上下文对象
    const context: SharedContext = {
      key,
      value: serialized.data,
      type: serialized.type,
      size: serialized.size,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy,
    };
    
    // 存储到 Redis
    await this.redis.hset(this.keyPrefix, key, JSON.stringify(context));
    await this.redis.expire(this.keyPrefix, this.ttl);
    
    // 发布事件
    this.eventEmitter?.emit('context.updated', {
      executionId: this.executionId,
      key,
      size: serialized.size,
      createdBy,
    });
  }
  
  /**
   * 获取上下文
   */
  async get(key: string): Promise<SharedContext | null> {
    const data = await this.redis.hget(this.keyPrefix, key);
    
    if (!data) {
      return null;
    }
    
    return JSON.parse(data);
  }
  
  /**
   * 获取上下文值
   */
  async getValue<T = any>(key: string): Promise<T | null> {
    const context = await this.get(key);
    
    if (!context) {
      return null;
    }
    
    return this.deserialize(context);
  }
  
  /**
   * 获取所有上下文
   */
  async getAll(): Promise<Map<string, SharedContext>> {
    const data = await this.redis.hgetall(this.keyPrefix);
    const result = new Map<string, SharedContext>();
    
    for (const [key, value] of Object.entries(data)) {
      result.set(key, JSON.parse(value));
    }
    
    return result;
  }
  
  /**
   * 删除上下文
   */
  async delete(key: string): Promise<boolean> {
    const result = await this.redis.hdel(this.keyPrefix, key);
    
    if (result > 0) {
      this.eventEmitter?.emit('context.deleted', {
        executionId: this.executionId,
        key,
      });
    }
    
    return result > 0;
  }
  
  /**
   * 清空所有上下文
   */
  async clear(): Promise<void> {
    await this.redis.del(this.keyPrefix);
    
    this.eventEmitter?.emit('context.cleared', {
      executionId: this.executionId,
    });
  }
  
  /**
   * 获取摘要信息
   */
  async getSummary(): Promise<{
    entryCount: number;
    totalSize: number;
    keys: string[];
  }> {
    const all = await this.getAll();
    const keys = Array.from(all.keys());
    const totalSize = Array.from(all.values()).reduce((sum, ctx) => sum + ctx.size, 0);
    
    return {
      entryCount: all.size,
      totalSize,
      keys,
    };
  }
  
  /**
   * 检查上下文是否存在
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.hexists(this.keyPrefix, key);
    return result === 1;
  }
  
  /**
   * 序列化值
   */
  private serialize(value: any): { data: string; type: 'string' | 'object' | 'buffer'; size: number } {
    if (Buffer.isBuffer(value)) {
      return {
        data: value.toString('base64'),
        type: 'buffer',
        size: value.length,
      };
    }
    
    if (typeof value === 'string') {
      return {
        data: value,
        type: 'string',
        size: Buffer.byteLength(value, 'utf8'),
      };
    }
    
    const jsonStr = JSON.stringify(value);
    return {
      data: jsonStr,
      type: 'object',
      size: Buffer.byteLength(jsonStr, 'utf8'),
    };
  }
  
  /**
   * 反序列化值
   */
  private deserialize<T>(context: SharedContext): T {
    switch (context.type) {
      case 'buffer':
        return Buffer.from(context.value, 'base64') as unknown as T;
      case 'string':
        return context.value as T;
      case 'object':
        return JSON.parse(context.value) as T;
      default:
        throw new Error(`Unknown context type: ${context.type}`);
    }
  }

  // ============================================
  // 🆕 会议纪要渐进式披露（AS-054）
  // ============================================

  /**
   * 存储会议元数据
   */
  async setMeetingMeta(meetingId: string, meta: MeetingMeta): Promise<void> {
    await this.set(`meeting:${meetingId}:meta`, meta);
  }

  /**
   * 获取会议元数据（阶段 1，~200 Token）
   */
  async getMeetingMeta(meetingId: string): Promise<MeetingMeta | null> {
    return this.getValue<MeetingMeta>(`meeting:${meetingId}:meta`);
  }

  /**
   * 存储会议决策
   */
  async setMeetingDecisions(meetingId: string, decisions: MeetingDecision[]): Promise<void> {
    await this.set(`meeting:${meetingId}:decisions`, decisions);
  }

  /**
   * 获取会议决策（阶段 2，~500 Token）
   */
  async getMeetingDecisions(meetingId: string): Promise<MeetingDecision[] | null> {
    return this.getValue<MeetingDecision[]>(`meeting:${meetingId}:decisions`);
  }

  /**
   * 追加会议决策
   */
  async appendMeetingDecision(meetingId: string, decision: MeetingDecision): Promise<void> {
    const key = `meeting:${meetingId}:decisions`;
    const existing = await this.get(key);
    const decisions = existing?.value || [];
    await this.set(key, [...decisions, decision]);
  }

  /**
   * 存储会议摘要
   */
  async setMeetingSummary(meetingId: string, summary: string): Promise<void> {
    await this.set(`meeting:${meetingId}:summary`, summary);
  }

  /**
   * 获取会议摘要（阶段 3，~2000 Token）
   */
  async getMeetingSummary(meetingId: string): Promise<string | null> {
    return this.getValue<string>(`meeting:${meetingId}:summary`);
  }

  /**
   * 存储会议消息（调试/审计用）
   */
  async setMeetingMessages(meetingId: string, messages: MeetingMessage[]): Promise<void> {
    await this.set(`meeting:${meetingId}:messages`, messages);
  }

  /**
   * 获取会议消息（阶段 4，按需）
   */
  async getMeetingMessages(meetingId: string): Promise<MeetingMessage[] | null> {
    return this.getValue<MeetingMessage[]>(`meeting:${meetingId}:messages`);
  }

  /**
   * 渐进式加载会议上下文
   * 
   * @param meetingId 会议 ID
   * @param stage 加载阶段（1-4）
   * @param tokenBudget Token 预算（可选，用于智能裁剪）
   */
  async getMeetingContext(
    meetingId: string,
    stage: 1 | 2 | 3 | 4 = 1,
    tokenBudget?: number
  ): Promise<MeetingContextProgressive> {
    const result: MeetingContextProgressive = {
      stage,
      meta: null,
      decisions: null,
      summary: null,
      messages: null,
    };

    // 阶段 1：始终加载元数据
    result.meta = await this.getMeetingMeta(meetingId);

    if (stage >= 2) {
      // 阶段 2：加载决策
      result.decisions = await this.getMeetingDecisions(meetingId);
    }

    if (stage >= 3) {
      // 阶段 3：加载摘要
      result.summary = await this.getMeetingSummary(meetingId);
    }

    if (stage >= 4) {
      // 阶段 4：加载完整消息
      result.messages = await this.getMeetingMessages(meetingId);
    }

    return result;
  }
}

// ============================================
// 🆕 会议纪要类型定义（AS-054）
// ============================================

import type { ConstraintLevel } from '@dommaker/studio-shared';

/**
 * 会议元数据（阶段 1）
 */
export interface MeetingMeta {
  meetingId: string;
  taskId?: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  summaryPreview?: string; // 200 字预览
  decisionCount?: number;
  messageCount?: number;
  participants?: string[];
  /**
   * 约束级别（AS-035）
   * 决定后续工作流的审批流程
   */
  constraintLevel?: ConstraintLevel;
}

/**
 * 会议决策（阶段 2）
 */
export interface MeetingDecision {
  id: string;
  content: string;
  agreed: boolean;
  roles?: string[];
  timestamp?: string;
  /**
   * 约束级别（AS-035）
   * 决策级别的约束
   */
  constraintLevel?: ConstraintLevel;
}

/**
 * 会议消息（阶段 4）
 */
export interface MeetingMessage {
  roleId: string;
  roleName?: string;
  content: string;
  timestamp?: string;
  messageType?: string;
}

/**
 * 渐进式会议上下文
 */
export interface MeetingContextProgressive {
  stage: 1 | 2 | 3 | 4;
  meta: MeetingMeta | null;
  decisions: MeetingDecision[] | null;
  summary: string | null;
  messages: MeetingMessage[] | null;
}

/**
 * 创建上下文共享器（便捷函数）
 */
export function createContextSharer(config: ContextSharerConfig): ContextSharer {
  return new ContextSharer(config);
}
