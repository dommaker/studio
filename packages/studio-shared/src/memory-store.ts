// MemoryStore — 内存替代 Redis (B0-011)
// 单进程模式下的 KV + Pub/Sub 替代
import { eventBus } from './event-bus.js';

const kvStore = new Map<string, string>();
const hashStore = new Map<string, Map<string, string>>();
const listStore = new Map<string, string[]>();

export const memoryStore = {
  // ── KV ──
  async get(key: string): Promise<string | null> {
    return kvStore.get(key) ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    kvStore.set(key, value);
  },
  async setex(key: string, _ttl: number, value: string): Promise<void> {
    kvStore.set(key, value);
  },
  async del(...keys: string[]): Promise<void> {
    for (const k of keys) kvStore.delete(k);
  },
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => kvStore.get(k) ?? null);
  },
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...kvStore.keys()].filter(k => k.startsWith(prefix));
  },

  // ── Hash ──
  async hset(key: string, field: string, value: string): Promise<void> {
    if (!hashStore.has(key)) hashStore.set(key, new Map());
    hashStore.get(key)!.set(field, value);
  },
  async hget(key: string, field: string): Promise<string | null> {
    return hashStore.get(key)?.get(field) ?? null;
  },
  async hgetall(key: string): Promise<Record<string, string>> {
    const h = hashStore.get(key);
    if (!h) return {};
    return Object.fromEntries(h);
  },

  // ── List (TaskQueue) ──
  async lpush(key: string, ...values: string[]): Promise<number> {
    if (!listStore.has(key)) listStore.set(key, []);
    listStore.get(key)!.unshift(...values);
    return listStore.get(key)!.length;
  },
  async rpush(key: string, ...values: string[]): Promise<number> {
    if (!listStore.has(key)) listStore.set(key, []);
    listStore.get(key)!.push(...values);
    return listStore.get(key)!.length;
  },
  async lpop(key: string): Promise<string | null> {
    const list = listStore.get(key);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  },
  async blpop(key: string, timeoutSeconds: number): Promise<string | null> {
    // 简化：非阻塞 pop，不真正等待（单进程无竞态）
    const list = listStore.get(key);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  },
  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = listStore.get(key);
    if (!list) return 0;
    let removed = 0;
    const absCount = Math.abs(count);
    for (let i = list.length - 1; i >= 0 && removed < absCount; i--) {
      if (list[i] === value) { list.splice(i, 1); removed++; }
    }
    return removed;
  },
  async llen(key: string): Promise<number> {
    return listStore.get(key)?.length ?? 0;
  },

  // ── Sorted Set (retry scheduling) ──
  async zadd(key: string, score: number, value: string): Promise<void> {
    if (!listStore.has(`z:${key}`)) listStore.set(`z:${key}`, []);
    listStore.get(`z:${key}`)!.push(`${score}:${value}`);
  },
  async zrangebyscore(key: string, min: number, max: number, _: string, __: number, ___: number): Promise<string[]> {
    const list = listStore.get(`z:${key}`);
    if (!list) return [];
    return list
      .map(e => { const [s, ...v] = e.split(':'); return { score: Number(s), value: v.join(':') }; })
      .filter(e => e.score >= min && e.score <= max)
      .sort((a, b) => a.score - b.score)
      .map(e => e.value)
      .slice(0, 1);
  },
  async zrem(key: string, value: string): Promise<void> {
    const list = listStore.get(`z:${key}`);
    if (!list) return;
    const idx = list.findIndex(e => e.endsWith(`:${value}`));
    if (idx >= 0) list.splice(idx, 1);
  },

  // ── Pub/Sub ──
  async publish(channel: string, message: string): Promise<void> {
    eventBus.publish(channel, JSON.parse(message));
  },
  subscribe(channel: string, handler: (message: string) => void): void {
    eventBus.subscribe(channel, (payload: any) =>
      handler(typeof payload === 'string' ? payload : JSON.stringify(payload))
    );
  },
  on(_event: string, _handler: (...args: any[]) => void): void {
    // no-op: Redis 'message' event pattern — handled via subscribe()
  },

  // ── Lifecycle ──
  async quit(): Promise<void> {
    // no-op: in-memory, no connection to close
  },
};
