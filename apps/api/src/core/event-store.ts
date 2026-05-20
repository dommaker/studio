// EventStore — Redis 替代 (B0-002: EventEmitter + 内存 Map)
// 提供 get/set/del/keys + pub/sub，全部走 eventBus + Map
import { eventBus } from '@dommaker/studio-shared';

const store = new Map<string, string>();
const hashStore = new Map<string, Map<string, string>>();

export class EventStore {
  // KV
  async get(key: string): Promise<string | null> { return store.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { store.set(key, value); }
  async setex(key: string, _ttl: number, value: string): Promise<void> { store.set(key, value); }
  async del(...keys: string[]): Promise<void> { for (const k of keys) store.delete(k); }
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...store.keys()].filter(k => k.startsWith(prefix));
  }

  // Hash
  async hset(key: string, field: string, value: string): Promise<void> {
    if (!hashStore.has(key)) hashStore.set(key, new Map());
    hashStore.get(key)!.set(field, value);
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    const h = hashStore.get(key);
    if (!h) return {};
    return Object.fromEntries(h);
  }

  // Pub/Sub
  async publish(channel: string, message: string): Promise<void> {
    try {
      eventBus.publish(channel, JSON.parse(message));
    } catch {
      // Non-JSON message — publish as raw string
      eventBus.publish(channel, message);
    }
  }
  subscribe(channel: string, handler: (message: string) => void): void {
    eventBus.subscribe(channel, (payload: any) => handler(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  }
  unsubscribe(channel: string, handler: (message: string) => void): void {
    eventBus.unsubscribe(channel, handler as any);
  }
  disconnect(): void { /* no-op */ }
}

export const eventStore = new EventStore();
