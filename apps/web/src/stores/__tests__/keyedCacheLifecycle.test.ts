import { describe, expect, it, vi } from 'vitest';
import { KeyedCacheLifecycle } from '../keyedCacheLifecycle';

describe('KeyedCacheLifecycle — 引用计数 / LRU / 非活跃释放', () => {
  it('活跃键不被 LRU 或超时释放，释放后按最近使用淘汰', () => {
    vi.useFakeTimers();
    const evicted: string[] = [];
    const cache = new KeyedCacheLifecycle({ maxInactive: 2, inactiveMs: 1000, onEvict: key => evicted.push(key) });
    const releaseA = cache.acquire('a');
    cache.touch('b');
    cache.touch('c');
    cache.touch('d');
    expect(evicted).toEqual(['b']);
    vi.advanceTimersByTime(5000);
    expect(cache.isActive('a')).toBe(true);
    expect(evicted).not.toContain('a');
    releaseA();
    cache.touch('c');
    vi.advanceTimersByTime(1000);
    expect(evicted).toContain('a');
    expect(cache.stats().timers).toBeLessThanOrEqual(1);
    cache.dispose();
    vi.useRealTimers();
  });

  it('同一键多个订阅者引用计数正确，重复 release 幂等', () => {
    const cache = new KeyedCacheLifecycle({ maxInactive: 2, inactiveMs: 1000, onEvict: () => {} });
    const release1 = cache.acquire('x');
    const release2 = cache.acquire('x');
    release1();
    release1();
    expect(cache.isActive('x')).toBe(true);
    release2();
    expect(cache.isActive('x')).toBe(false);
    expect(cache.stats().keys).toBe(1);
    cache.dispose();
  });
});
