/**
 * TwoLevelContextSharer - 两级缓存
 * 
 * DD-020: L1 内存 + L2 Redis 缓存
 * 
 * 用途：
 * - 热点数据（角色信息、项目配置）
 * - 减少重复 DB/Redis 调用
 * - 任务执行期间快速访问
 */

import { logger, memoryStore } from '@dommaker/studio-shared';

/**
 * 缓存配置
 */
interface CacheConfig {
  l1TtlMs?: number;  // L1 内存 TTL（毫秒）
  l2TtlSec?: number; // L2 Redis TTL（秒）
}

/**
 * 缓存条目（L1 内存）
 */
interface CacheEntry<T> {
  value: T;
  expireAt: number;  // 过期时间戳（毫秒）
}

/**
 * ContextSharer 接口
 */
export interface ContextSharer {
  getValue<T>(key: string): Promise<T | null>;
  setValue<T>(key: string, value: T, ttl?: number): Promise<void>;
  deleteValue(key: string): Promise<void>;
}

/**
 * 两级缓存实现
 * 
 * L1: 内存 Map（热点数据，30秒 TTL）
 * L2: Redis（跨 Execution 共享，5分钟 TTL）
 */
export class TwoLevelContextSharer implements ContextSharer {
  private store: typeof memoryStore;
  private l1Cache: Map<string, CacheEntry<any>>;
  private defaultL1TtlMs: number;
  private defaultL2TtlSec: number;

  constructor(config: CacheConfig = {}) {
    this.store = memoryStore;
    this.l1Cache = new Map();
    this.defaultL1TtlMs = config.l1TtlMs ?? 30000;  // 30 秒
    this.defaultL2TtlSec = config.l2TtlSec ?? 300;  // 5 分钟
  }

  async getValue<T>(key: string): Promise<T | null> {
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry && l1Entry.expireAt > Date.now()) {
      logger.debug('L1 cache hit', { key });
      return l1Entry.value as T;
    }
    if (l1Entry) this.l1Cache.delete(key);

    const l2Data = await this.store.get(key);
    if (l2Data) {
      logger.debug('L2 cache hit', { key });
      const value = this.parseValue(l2Data);
      this.setL1(key, value, this.defaultL1TtlMs);
      return value as T;
    }

    logger.debug('Cache miss', { key });
    return null;
  }

  async setValue<T>(key: string, value: T, ttl?: number): Promise<void> {
    const l2Ttl = ttl ?? this.defaultL2TtlSec;
    const l1TtlMs = (ttl ?? this.defaultL2TtlSec) * 1000;
    const data = JSON.stringify(value);
    if (l2Ttl > 0) {
      await this.store.setex(key, l2Ttl, data);
    } else {
      await this.store.set(key, data);
    }
    this.setL1(key, value, Math.min(l1TtlMs, this.defaultL1TtlMs));
    logger.debug('Cache set', { key, l2Ttl, l1TtlMs });
  }

  async deleteValue(key: string): Promise<void> {
    this.l1Cache.delete(key);
    await this.store.del(key);
    logger.debug('Cache deleted', { key });
  }

  async getValues<T>(keys: string[]): Promise<Map<string, T | null>> {
    const results = new Map<string, T | null>();
    const l2Keys: string[] = [];
    for (const key of keys) {
      const l1Entry = this.l1Cache.get(key);
      if (l1Entry && l1Entry.expireAt > Date.now()) {
        results.set(key, l1Entry.value as T);
      } else {
        l2Keys.push(key);
        if (l1Entry) this.l1Cache.delete(key);
      }
    }
    if (l2Keys.length > 0) {
      const l2Values = await this.store.mget(...l2Keys);
      for (let i = 0; i < l2Keys.length; i++) {
        const key = l2Keys[i];
        const data = l2Values[i];
        if (data) {
          const value = this.parseValue(data);
          results.set(key, value as T);
          this.setL1(key, value, this.defaultL1TtlMs);
        } else {
          results.set(key, null);
        }
      }
    }
    return results;
  }

  /**
   * 预加载热点数据（可选）
   */
  async preload<K, V>(entries: Array<{ key: string; loader: () => Promise<V> }>): Promise<void> {
    for (const entry of entries) {
      const cached = await this.getValue<V>(entry.key);
      if (!cached) {
        const value = await entry.loader();
        await this.setValue(entry.key, value);
        logger.info('Cache preloaded', { key: entry.key });
      }
    }
  }

  /**
   * 设置 L1 内存缓存
   */
  private setL1<T>(key: string, value: T, ttlMs: number): void {
    const expireAt = Date.now() + ttlMs;
    this.l1Cache.set(key, { value, expireAt });
  }

  /**
   * 解析值
   */
  private parseValue(data: string): any {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  /**
   * 清除所有 L1 缓存
   */
  clearL1(): void {
    this.l1Cache.clear();
    logger.info('L1 cache cleared');
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    l1Size: number;
    l1Keys: string[];
  } {
    return {
      l1Size: this.l1Cache.size,
      l1Keys: Array.from(this.l1Cache.keys()),
    };
  }
}

/**
 * 带数据加载器的缓存
 * 
 * 自动回源 DB/Prisma
 */
export class DataLoaderCache<T> {
  private sharer: TwoLevelContextSharer;
  private loader: (id: string) => Promise<T>;
  private keyPrefix: string;

  constructor(
    keyPrefix: string,
    loader: (id: string) => Promise<T>,
    sharer?: TwoLevelContextSharer
  ) {
    this.keyPrefix = keyPrefix;
    this.loader = loader;
    this.sharer = sharer ?? new TwoLevelContextSharer();
  }

  /**
   * 获取值（自动回源）
   */
  async get(id: string): Promise<T | null> {
    const key = `${this.keyPrefix}:${id}`;
    
    const cached = await this.sharer.getValue<T>(key);
    if (cached) {
      return cached;
    }
    
    // 回源加载
    try {
      const value = await this.loader(id);
      await this.sharer.setValue(key, value);
      return value;
    } catch (error) {
      logger.warn('Data loader failed', { key, error: String(error) });
      return null;
    }
  }

  /**
   * 批量获取
   */
  async getMany(ids: string[]): Promise<Map<string, T | null>> {
    const results = new Map<string, T | null>();
    const uncachedIds: string[] = [];
    
    // 先查缓存
    for (const id of ids) {
      const cached = await this.get(id);
      if (cached) {
        results.set(id, cached);
      } else {
        uncachedIds.push(id);
      }
    }
    
    // 批量加载未缓存的
    if (uncachedIds.length > 0) {
      for (const id of uncachedIds) {
        results.set(id, await this.get(id));
      }
    }
    
    return results;
  }

  /**
   * 清除缓存（数据更新时调用）
   */
  async clear(id: string): Promise<void> {
    const key = `${this.keyPrefix}:${id}`;
    await this.sharer.deleteValue(key);
  }
}

// 导出单例
export const contextSharer = new TwoLevelContextSharer();