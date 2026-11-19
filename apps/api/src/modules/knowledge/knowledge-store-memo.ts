/**
 * MtimeMemoKnowledgeStore — FileKnowledgeStore 的 manifest generation 聚合 memo 包装（#343 / PERF-04）。
 *
 * 缓存 seam 定位（ADR docs/adr/2026-08-24-cache-seam-decision-rules.md「外部包存储栈」条款）：
 * 真源是磁盘文件，但管理它的存储栈来自外部包（harness FileKnowledgeStore，npm 固定版本），
 * 进不了 studio-shared FileStore 读穿 seam → 决策树第 3 问「聚合 memo」，贴着
 * knowledge-singletons 的 sharedStore 组装点放置。失效口径（写在构造处）：
 *   - 本进程写穿透：save/saveAll/applyAll/update/delete/rebuildIndex 同步失效全部 memo；
 *   - 跨进程外部写：FileKnowledgeStore 每次条目写都重写 index.json；读前只 stat 这一份
 *     manifest，以 dev/ino/mtimeNs/ctimeNs/size 组成 generation。generation 不变则复用
 *     只读 memo 快照，有变则全量重扫；稳态校验 O(1)，不再 readdir 或逐条目 stat。
 *
 * 读语义基线：底层 list()/get() 每次返回全新对象，调用方（recordOutcome 等）
 * 会原地改嵌套数组——memo 命中一律 structuredClone 后返回，保持该既有契约。
 *
 * 直通不缓存：readEntriesFromDisk（显式磁盘核对，linter 一致性检查依赖）/
 * snapshot / getSnapshot / getSurvivalRate（低频度量路径）/
 * getConsumptionStats（#134 新增，stats 文件不在指纹内）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMetricsBegin, emitReadMetric } from '@dommaker/studio-shared/read-metrics';
import type { KnowledgeEntry, KnowledgeStore, QueryFilter } from '@dommaker/harness';

type IndexEntries = ReturnType<KnowledgeStore['readIndex']>;

export class MtimeMemoKnowledgeStore implements KnowledgeStore {
  private readonly underlying: KnowledgeStore;
  /** manifest generation → 只读 memo 快照（generation 变或写穿透即整体清空） */
  private generation: string | null = null;
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

  /** harness#107 批量写：与 save 同一写穿透口径——整批落盘后统一失效 */
  saveAll(entries: KnowledgeEntry[]): void {
    this.underlying.saveAll(entries);
    this.invalidate();
  }

  /** harness#134（1.8.0 KnowledgeStore 15 成员）批量补丁写：与 saveAll 同一写穿透口径 */
  applyAll(updates: Parameters<KnowledgeStore['applyAll']>[0]): void {
    this.underlying.applyAll(updates);
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

  /**
   * harness#134（1.8.0 KnowledgeStore 15 成员）消费计数：直通不缓存——
   * .consumption-stats.json 不在目录指纹（.md + index.json）覆盖内，
   * 缓存会返回过期计数；调用方（KnowledgeAudit 打分）低频。
   */
  getConsumptionStats(): ReturnType<KnowledgeStore['getConsumptionStats']> {
    return this.underlying.getConsumptionStats();
  }

  // ── memo 内核 ──────────────────────────────────────────

  private invalidate(): void {
    this.generation = null;
    this.memo.clear();
  }

  /**
   * FileKnowledgeStore 的所有条目写都同步重写 index.json，因此它就是 store manifest。
   * 每次读只 stat 这一份 manifest，以纳秒 mtime/ctime + inode + size 组成 generation；
   * 同一 generation 复用 memo，稳态校验为 O(1)，与条目数无关。
   */
  private readManifestGeneration(baseDir: string): string {
    try {
      const st = fs.statSync(path.join(baseDir, 'index.json'), { bigint: true });
      return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`;
    } catch { /* manifest 暂缺/读口竞态：按独立 generation 处理，创建后必失效 */ }
    return 'missing';
  }

  private readThrough<T>(key: string, load: () => T): T {
    const timer = readMetricsBegin();
    const baseDir = this.underlying.getBaseDir();

    const tStat0 = timer?.() ?? 0;
    const generation = this.readManifestGeneration(baseDir);
    const statMs = (timer?.() ?? 0) - tStat0;
    if (generation !== this.generation) {
      this.generation = generation;
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
