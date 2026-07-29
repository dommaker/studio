// MemoryStore — 内存 KV + Pub/Sub 存储
// 单进程模式下的 KV + Pub/Sub 替代
import { eventBus } from './event-bus.js';
const kvStore = new Map();
const hashStore = new Map();
const listStore = new Map();
export const memoryStore = {
    // ── KV ──
    async get(key) {
        return kvStore.get(key) ?? null;
    },
    async set(key, value) {
        kvStore.set(key, value);
    },
    async setex(key, _ttl, value) {
        kvStore.set(key, value);
    },
    async del(...keys) {
        for (const k of keys)
            kvStore.delete(k);
    },
    async mget(...keys) {
        return keys.map(k => kvStore.get(k) ?? null);
    },
    async keys(pattern) {
        const prefix = pattern.replace(/\*$/, '');
        return [...kvStore.keys()].filter(k => k.startsWith(prefix));
    },
    // ── Hash ──
    async hset(key, field, value) {
        if (!hashStore.has(key))
            hashStore.set(key, new Map());
        hashStore.get(key).set(field, value);
    },
    async hget(key, field) {
        return hashStore.get(key)?.get(field) ?? null;
    },
    async hgetall(key) {
        const h = hashStore.get(key);
        if (!h)
            return {};
        return Object.fromEntries(h);
    },
    // ── List (TaskQueue) ──
    async lpush(key, ...values) {
        if (!listStore.has(key))
            listStore.set(key, []);
        listStore.get(key).unshift(...values);
        return listStore.get(key).length;
    },
    async rpush(key, ...values) {
        if (!listStore.has(key))
            listStore.set(key, []);
        listStore.get(key).push(...values);
        return listStore.get(key).length;
    },
    async lpop(key) {
        const list = listStore.get(key);
        if (!list || list.length === 0)
            return null;
        return list.shift() ?? null;
    },
    async blpop(key, timeoutSeconds) {
        // 简化：非阻塞 pop，不真正等待（单进程无竞态）
        const list = listStore.get(key);
        if (!list || list.length === 0)
            return null;
        return list.shift() ?? null;
    },
    async lrem(key, count, value) {
        const list = listStore.get(key);
        if (!list)
            return 0;
        let removed = 0;
        const absCount = Math.abs(count);
        for (let i = list.length - 1; i >= 0 && removed < absCount; i--) {
            if (list[i] === value) {
                list.splice(i, 1);
                removed++;
            }
        }
        return removed;
    },
    async llen(key) {
        return listStore.get(key)?.length ?? 0;
    },
    // ── Sorted Set (retry scheduling) ──
    async zadd(key, score, value) {
        if (!listStore.has(`z:${key}`))
            listStore.set(`z:${key}`, []);
        listStore.get(`z:${key}`).push(`${score}:${value}`);
    },
    async zrangebyscore(key, min, max, _, __, ___) {
        const list = listStore.get(`z:${key}`);
        if (!list)
            return [];
        return list
            .map(e => { const [s, ...v] = e.split(':'); return { score: Number(s), value: v.join(':') }; })
            .filter(e => e.score >= min && e.score <= max)
            .sort((a, b) => a.score - b.score)
            .map(e => e.value)
            .slice(0, 1);
    },
    async zrem(key, value) {
        const list = listStore.get(`z:${key}`);
        if (!list)
            return;
        const idx = list.findIndex(e => e.endsWith(`:${value}`));
        if (idx >= 0)
            list.splice(idx, 1);
    },
    // ── Pub/Sub ──
    async publish(channel, message) {
        eventBus.publish(channel, JSON.parse(message));
    },
    subscribe(channel, handler) {
        eventBus.subscribe(channel, (payload) => handler(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    },
    on(_event, _handler) {
        // no-op: message event pattern — handled via subscribe()
    },
    // ── Lifecycle ──
    async quit() {
        // no-op: in-memory, no connection to close
    },
};
//# sourceMappingURL=memory-store.js.map