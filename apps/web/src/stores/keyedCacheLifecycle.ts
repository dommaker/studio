// per-key 数据面驻留生命周期（PERF-06）：只抽引用计数、非活跃 LRU 与释放计时，
// 不抽数据存法。每个实例至多一个释放 timer；活跃键不参与淘汰。
export interface KeyedCacheLifecycleOptions {
  /** 非活跃驻留上限；活跃订阅键允许临时超过，释放后立即收敛。 */
  maxInactive: number;
  inactiveMs: number;
  onEvict: (key: string) => void;
}

interface Entry {
  refs: number;
  lastUsed: number;
  incarnation: number;
}

export class KeyedCacheLifecycle {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextIncarnation = 0;

  constructor(private readonly options: KeyedCacheLifecycleOptions) {}

  acquire(key: string): () => void {
    const entry = this.touchEntry(key);
    entry.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.entries.get(key);
      if (!cur) return;
      cur.refs = Math.max(0, cur.refs - 1);
      cur.lastUsed = Date.now();
      this.entries.delete(key);
      this.entries.set(key, cur);
      this.enforceLimit();
      this.schedule();
    };
  }

  touch(key: string): void {
    this.touchEntry(key);
    this.enforceLimit();
    this.schedule();
  }

  private touchEntry(key: string): Entry {
    const cur = this.entries.get(key) ?? { refs: 0, lastUsed: Date.now(), incarnation: ++this.nextIncarnation };
    cur.lastUsed = Date.now();
    this.entries.delete(key);
    this.entries.set(key, cur);
    return cur;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 淘汰后同键重建必换值；响应同时校验它才能防 ABA。 */
  incarnation(key: string): number {
    return this.entries.get(key)?.incarnation ?? 0;
  }

  isActive(key: string): boolean {
    return (this.entries.get(key)?.refs ?? 0) > 0;
  }

  activeKeys(): string[] {
    const keys: string[] = [];
    for (const [key, entry] of this.entries) if (entry.refs > 0) keys.push(key);
    return keys;
  }

  stats(): { keys: number; activeKeys: number; timers: number } {
    return { keys: this.entries.size, activeKeys: this.activeKeys().length, timers: this.timer ? 1 : 0 };
  }

  private enforceLimit(): void {
    let inactive = 0;
    for (const entry of this.entries.values()) if (entry.refs === 0) inactive += 1;
    if (inactive <= this.options.maxInactive) return;
    for (const [key, entry] of this.entries) {
      if (entry.refs > 0) continue;
      this.evict(key);
      inactive -= 1;
      if (inactive <= this.options.maxInactive) break;
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let nextAt: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.refs > 0) continue;
      const at = entry.lastUsed + this.options.inactiveMs;
      if (nextAt === null || at < nextAt) nextAt = at;
    }
    if (nextAt === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.refs === 0 && entry.lastUsed + this.options.inactiveMs <= now) this.evict(key);
      }
      this.enforceLimit();
      this.schedule();
    }, Math.max(0, nextAt - Date.now()));
  }

  private evict(key: string): void {
    if (!this.entries.delete(key)) return;
    this.options.onEvict(key);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.entries.clear();
  }
}
