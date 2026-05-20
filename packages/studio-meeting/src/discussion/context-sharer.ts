/**
 * Redis Context Sharer
 * 
 * DD-008: ContextSharer 接口的 Redis 实现
 * 用于 DiscussionDriver 获取会议上下文
 */

import { memoryStore } from '@dommaker/studio-shared';

/**
 * ContextSharer 接口（简化版）
 */
export interface ContextSharer {
  getValue<T>(key: string): Promise<T | null>;
  setValue<T>(key: string, value: T, ttl?: number): Promise<void>;
  deleteValue(key: string): Promise<void>;
}

/**
 * Redis Context Sharer 实现（B0-011: Redis → MemoryStore）
 */
export class ContextSharerImpl implements ContextSharer {
  private store: typeof memoryStore;

  constructor(store?: typeof memoryStore) {
    this.store = store || memoryStore;
  }

  async getValue<T>(key: string): Promise<T | null> {
    const data = await this.store.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as T;
    } catch {
      return data as unknown as T;
    }
  }

  async setValue<T>(key: string, value: T, ttl?: number): Promise<void> {
    const data = JSON.stringify(value);
    if (ttl) {
      await this.store.setex(key, ttl, data);
    } else {
      await this.store.set(key, data);
    }
  }

  async deleteValue(key: string): Promise<void> {
    await this.store.del(key);
  }
}

// 导出单例
export const contextSharer = new ContextSharerImpl();