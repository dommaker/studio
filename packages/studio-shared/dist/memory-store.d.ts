export declare const memoryStore: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    setex(key: string, _ttl: number, value: string): Promise<void>;
    del(...keys: string[]): Promise<void>;
    mget(...keys: string[]): Promise<(string | null)[]>;
    keys(pattern: string): Promise<string[]>;
    hset(key: string, field: string, value: string): Promise<void>;
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string>>;
    lpush(key: string, ...values: string[]): Promise<number>;
    rpush(key: string, ...values: string[]): Promise<number>;
    lpop(key: string): Promise<string | null>;
    blpop(key: string, timeoutSeconds: number): Promise<string | null>;
    lrem(key: string, count: number, value: string): Promise<number>;
    llen(key: string): Promise<number>;
    zadd(key: string, score: number, value: string): Promise<void>;
    zrangebyscore(key: string, min: number, max: number, _: string, __: number, ___: number): Promise<string[]>;
    zrem(key: string, value: string): Promise<void>;
    publish(channel: string, message: string): Promise<void>;
    subscribe(channel: string, handler: (message: string) => void): void;
    on(_event: string, _handler: (...args: any[]) => void): void;
    quit(): Promise<void>;
};
//# sourceMappingURL=memory-store.d.ts.map