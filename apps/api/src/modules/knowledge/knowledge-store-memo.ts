/**
 * MtimeMemoKnowledgeStore — FileKnowledgeStore 的 mtime 校验聚合 memo 包装（#343）。
 *
 * 缓存 seam 定位（ADR docs/adr/2026-08-24-cache-seam-decision-rules.md「外部包存储栈」条款）：
 * 真源是磁盘文件，但管理它的存储栈来自外部包（harness FileKnowledgeStore，npm 固定版本），
 * 进不了 studio-shared FileStore 读穿 seam → 决策树第 3 问「聚合 memo」，贴着
 * knowledge-singletons 的 sharedStore 组装点放置。失效口径（写在构造处）：
 *   - 本进程写穿透：save/update/delete/rebuildIndex 同步失效全部 memo；
 *   - 跨进程外部写：每次读前重算指纹（readdir + 逐文件 stat，mtimeMs+size），
 *     指纹不变 → memo 有效；有变 → 全量重扫。残余风险与 FileStore seam 的 mtime
 *     兜底同量级：外部同毫秒且等长改写不可见（本进程写不受此限）。
 *
 * 读语义基线：底层 list()/get() 每次返回全新对象，调用方（recordOutcome 等）
 * 会原地改嵌套数组——memo 命中一律 structuredClone 后返回，保持该既有契约。
 *
 * 直通不缓存：readEntriesFromDisk（显式磁盘核对，linter 一致性检查依赖）/
 * snapshot / getSnapshot / getSurvivalRate（低频度量路径）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMetricsBegin, emitReadMetric } from '@dommaker/studio-shared/read-metrics';
import type { KnowledgeEntry, KnowledgeStore, QueryFilter } from '@dommaker/harness';

type IndexEntries = ReturnType<KnowledgeStore['readIndex']>;

export class MtimeMemoKnowledgeStore implements KnowledgeStore {
  private readonly underlying: KnowledgeStore;
  /** 指纹 → memo（指纹变或写穿透即整体清空；key = filter JSON / 条目 id） */
  private fingerprint: string | null = null;
  private readonly memo = new Map<string, unknown>();

  constructor(underlying: KnowledgeStore) {
    this.underlying = underlying;
  }

  getBaseDir(): string {
    return this.underlying.getBaseDir();
  }

  get(id: string): KnowledgeEntry | undefined {
    return this.readThrough(id, () => this.underlying.get(id));
  }

  list(filter?: QueryFilter): KnowledgeEntry[] {
    return this.readThrough(JSON.stringify(filter ?? null), () => this.underlying.list(filter));
  }

  readIndex(): IndexEntries {
    return this.readThrough('index', () => this.underlying.readIndex());
  }

  save(entry: KnowledgeEntry): void {
    this.underlying.save(entry);
    this.invalidate();
  }

  delete(id: string): boolean {
    const removed = this.underlying.delete(id);
    this.invalidate();
    return removed;
  }

  update(id: string, partial: Partial<KnowledgeEntry>): KnowledgeEntry | undefined {
    const updated = this.underlying.update(id, partial);
    this.invalidate();
    return updated;
  }

  rebuildIndex(): void {
    this.underlying.rebuildIndex();
    this.invalidate();
  }

  // ── 直通（不缓存）──────────────────────────────────────

  readEntriesFromDisk(): KnowledgeEntry[] {
    return this.underlying.readEntriesFromDisk();
  }

  snapshot(): string {
    return this.underlying.snapshot();
  }

  getSnapshot(date: string): IndexEntries | undefined {
    return this.underlying.getSnapshot(date);
  }

  getSurvivalRate(daysAgo: number): ReturnType<KnowledgeStore['getSurvivalRate']> {
    return this.underlying.getSurvivalRate(daysAgo);
  }

  // ── memo 内核 ──────────────────────────────────────────

  private invalidate(): void {
    this.fingerprint = null;
    this.memo.clear();
  }

  /**
   * 目录指纹：readdir 顶层 + 逐文件 stat（.md 与 index.json），名称/mtimeMs/size 全参与比较。
   * 每次读口调用都会重算一次；N 为条目数（生产 ~200），stat 代价比 read+YAML.parse 低两个量级。
   */
  private scanFingerprint(baseDir: string): string {
    const names = fs.readdirSync(baseDir).filter(n => n.endsWith('.md') || n === 'index.json').sort();
    const parts: string[] = [];
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(baseDir, name));
        parts.push(`${name}:${st.mtimeMs}:${st.size}`);
      } catch { /* 读口竞态：文件刚被删 → 视为指纹组成缺席 */ }
    }
    return parts.join('|');
  }

  private readThrough<T>(key: string, load: () => T): T {
    const timer = readMetricsBegin();
    const baseDir = this.underlying.getBaseDir();

    const tStat0 = timer?.() ?? 0;
    const fp = this.scanFingerprint(baseDir);
    const statMs = (timer?.() ?? 0) - tStat0;
    if (fp !== this.fingerprint) {
      this.fingerprint = fp;
      this.memo.clear();
    }

    if (this.memo.has(key)) {
      const tClone0 = timer?.() ?? 0;
      const cloned = structuredClone(this.memo.get(key) as T);
      if (timer) {
        emitReadMetric({ file: baseDir, op: 'knowledgeRead', cacheHit: true, statMs, readParseMs: 0, cloneMs: (timer?.() ?? 0) - tClone0 });
      }
      return cloned;
    }

    const tLoad0 = timer?.() ?? 0;
    const loaded = load();
    const tLoad1 = timer?.() ?? 0;
    this.memo.set(key, loaded);
    const cloned = structuredClone(loaded);
    if (timer) {
      emitReadMetric({ file: baseDir, op: 'knowledgeRead', cacheHit: false, statMs, readParseMs: tLoad1 - tLoad0, cloneMs: (timer?.() ?? 0) - tLoad1 });
    }
    return cloned;
  }
}
