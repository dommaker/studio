/**
 * WorkUnitStore — FileStore 的 WorkUnit 事件溯源域 store（#681 P1-1 组合化：
 * 自 FileStoreWorkUnitBase 继承层转型为构造注入 FileStoreCore 的独立 store）
 *
 * events.jsonl 事件流 + append-only index.json + current/ per-WU 当前态投影。
 * 裸原语与 withLock 经 ctx.base（FileStoreBase）；默认读写走 ctx.io（CachedFileIo
 * 读穿缓存，唯一实现）；锁内点查直读 current projection/manifest（PERF-02），
 * 不 fold 历史 index、不经 mtime cache；reconcile/显式重建才全量读事件与 index。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isErrnoError } from './file-store-base';
import type { FileStoreCore } from './file-store-core';
import { jsonCache, cacheSet, statMtimeMs, cloneCached } from './cache-primitives';
import { readMetricsBegin, emitReadMetric } from '../read-metrics';
import type { WorkUnitEvent, WorkUnitSnapshot, WorkUnitFilter } from './file-store-types';
import {
  parseWorkUnitCurrentManifest,
  parseWorkUnitCurrentProjection,
  parseWorkUnitProjectionHead,
  sameWorkUnitLogPosition,
  workUnitProjectionFileName,
  type WorkUnitCurrentManifest,
  type WorkUnitLogPosition,
} from './workunit-current-projection';

/** #314（D2）：租约推前的合并落盘窗口（默认 60s，≪ 5min 租约 TTL，活跃持有方不被误判到期） */
export const LEASE_FLUSH_INTERVAL_MS = 60_000;

// ─── index.json append-only（#524 P1-2，#517 项 1 定案）───
//
// index.json 改 append-only JSONL：upsert 追加一行快照、remove 追加一行 {id, deleted:true}
// 墓碑；读侧 fold 出最新状态（同 id 后行覆盖前行、墓碑删除、首现位置序），
// 替代「每次建单/状态迁移全量重写」——写侧耗时不再随 WU 数线性增长。
// 定期压实（同 #319 messages 压实先例）：每 checkInterval 次 append 评估一次，
// 总行数 ≥ minLines 且死行（被覆盖旧行 + 墓碑行）占比 ≥ deadRatio 时锁内重写为 fold 结果。
// fsync 随每写全量重写一起取消（append 本就不 fsync）；崩溃撕裂尾行读侧跳过，
// 启动 reconcileIndex 按 events（正本）重建兜底——index 只是派生物。
// 旧格式（pretty JSON 数组）兼容：读侧首字符 '[' 走旧解析（严格抛错语义保留）；
// 写侧首个 append 前锁内一次性迁移重写为 JSONL。
const INDEX_COMPACT_CHECK_INTERVAL = 500;
const INDEX_COMPACT_MIN_LINES = 5000;
const INDEX_COMPACT_DEAD_RATIO = 0.3;

/** index.json 压实阈值（测试可注入小阈值，同 messageCompaction 模式） */
export interface IndexCompactionOptions {
  checkInterval?: number;
  minLines?: number;
  deadRatio?: number;
}

/** index.json 的删除墓碑行（removeSnapshot 追加；fold 时整条移除） */
interface WorkUnitIndexTombstone {
  id: string;
  deleted: true;
}

/**
 * index.json 内容 → 快照数组（双格式；bench/脚本直读方与 readIndexFile 共用，口径唯一）。
 * 旧格式（首非空白字符 '['）：JSON 数组，撕裂/非数组抛错（不静默当空）。
 * JSONL：逐行 fold——同 id 后行覆盖前行（内容挂首现位置，同 mergeActiveRows 口径）、
 * {id, deleted:true} 墓碑删除；JSON 撕裂行跳过（append 崩溃尾行容错，
 * events 是正本，reconcileIndex 兜底重建）；解析成功但缺字符串 id 的行 = 损坏 → 抛错
 * （保留「损坏不静默当空」防线）。
 */
export function parseWorkUnitIndexContent(content: string, sourcePath = 'index.json'): WorkUnitSnapshot[] {
  const trimmed = content.trimStart();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `WorkUnit index corrupted (JSON parse failed): ${sourcePath}` +
        `${err instanceof Error ? ` — ${err.message}` : ''}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`WorkUnit index corrupted (not an array): ${sourcePath}`);
    }
    return parsed as WorkUnitSnapshot[];
  }
  const byId = new Map<string, WorkUnitSnapshot>();
  for (const line of content.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let row: unknown;
    try {
      row = JSON.parse(l);
    } catch {
      continue; // 撕裂尾行跳过（append 中途崩溃的正常残留）
    }
    if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') {
      throw new Error(`WorkUnit index corrupted (JSONL row missing id): ${sourcePath}`);
    }
    const r = row as WorkUnitSnapshot | WorkUnitIndexTombstone;
    if ((r as WorkUnitIndexTombstone).deleted === true) {
      byId.delete(r.id);
    } else {
      byId.set(r.id, r as WorkUnitSnapshot); // Map 保留首现位置
    }
  }
  return Array.from(byId.values());
}

/** WorkUnitStore 构造选项 */
export interface FileStoreWorkUnitOptions {
  /** 租约推前的落盘间隔（测试注入 0 = 每跳即落盘的即时持久化契约） */
  leaseFlushIntervalMs?: number;
  /** #524 P1-2：index.json 压实阈值（测试注入小阈值） */
  indexCompaction?: IndexCompactionOptions;
}

/** 缓冲的租约推前项（fencing 令牌 + 待落盘新值） */
interface PendingLeaseRefresh {
  assigneeId: string;
  claimedAt: string;
  timeoutAt: string;
  updatedAt: string;
}

export class WorkUnitStore {
  private readonly ctx: FileStoreCore;
  private readonly leaseFlushIntervalMs: number;
  /** 上次落盘时刻；初始化为构造时刻（首个落盘窗口自实例创建起算，语义无害） */
  private lastLeaseFlushAt: number;
  private readonly pendingLeaseRefreshes = new Map<string, PendingLeaseRefresh>();
  /** #524 P1-2：index 压实阈值与 append 计数（进程内存，重启清零最多延迟一轮评估——同 #319 先例） */
  private readonly indexCompaction: Required<IndexCompactionOptions>;
  private indexAppendCount = 0;
  /** 同文件读穿 miss 合并；命中后仍只克隆过滤行。 */
  private indexReadFlight: Promise<WorkUnitSnapshot[] | null> | null = null;
  /** PERF-03：本进程成功写 index 后单调递增；跨进程新鲜度仍由 mtime/15s 兜底保证。 */
  private indexVersion = 0;

  constructor(ctx: FileStoreCore, opts?: FileStoreWorkUnitOptions) {
    this.ctx = ctx;
    this.leaseFlushIntervalMs = opts?.leaseFlushIntervalMs ?? LEASE_FLUSH_INTERVAL_MS;
    this.lastLeaseFlushAt = Date.now();
    this.indexCompaction = {
      checkInterval: opts?.indexCompaction?.checkInterval ?? INDEX_COMPACT_CHECK_INTERVAL,
      minLines: opts?.indexCompaction?.minLines ?? INDEX_COMPACT_MIN_LINES,
      deadRatio: opts?.indexCompaction?.deadRatio ?? INDEX_COMPACT_DEAD_RATIO,
    };
  }

  private get lockDir(): string {
    return path.join(this.ctx.baseDir, 'workunits', 'lock');
  }

  private get eventsPath(): string {
    return path.join(this.ctx.baseDir, 'workunits', 'events.jsonl');
  }

  private get indexPath(): string {
    return path.join(this.ctx.baseDir, 'workunits', 'index.json');
  }

  private get currentDir(): string {
    return path.join(this.ctx.baseDir, 'workunits', 'current');
  }

  private get currentManifestPath(): string {
    return path.join(this.currentDir, 'manifest.json');
  }

  private get legacyPendingPath(): string {
    return path.join(this.currentDir, 'legacy-pending.json');
  }

  private get currentHeadsDir(): string {
    return path.join(this.currentDir, 'heads');
  }

  private currentProjectionPath(wuId: string): string {
    return path.join(this.currentDir, workUnitProjectionFileName(wuId));
  }

  private currentHeadPath(wuId: string): string {
    return path.join(this.currentHeadsDir, workUnitProjectionFileName(wuId));
  }

  // ═══════════════════════
  // WorkUnit Event Sourcing
  // ═══════════════════════

  /** legacy 单事件原语：只追加 events，不写 index/projection；仍持锁并拒绝半行后续写。 */
  async appendEvent(event: WorkUnitEvent): Promise<void> {
    await this.ctx.base.withLock(this.lockDir, async () => {
      const recovered = await this.recoverLegacyPendingLocked();
      if (recovered) {
        // 只写事件的旧契约无法同时提交 legacy index/current；拒绝本次 append，调用方改走 commitSnapshot。
        throw new Error('WorkUnit legacy pending recovered; appendEvent requires commitSnapshot for the next event');
      }
      await this.readLogPositionLocked();
      await this.ctx.io.appendJsonl(this.eventsPath, event);
    });
  }

  /**
   * 读取 workunits/index.json 快照数组（双格式 fold，口径 = parseWorkUnitIndexContent）。
   * 文件不存在 → null（调用方按空处理）。旧格式（JSON 数组）撕裂/非数组、
   * JSONL 缺 id 行 → 抛出带路径的错误（损坏绝不静默当空——防止后续基于空数组
   * 回写把全部已有快照抹掉）；JSONL 撕裂尾行跳过（append 崩溃容错，
   * events 是正本，reconcileIndex 兜底）。
   * 永远裸读（不走缓存）：仅供 legacy bootstrap、reconcile/显式重建与锁外缓存 miss；
   * 锁内当前态点查不得调用本方法（PERF-02）。
   */
  private async readIndexFile(): Promise<WorkUnitSnapshot[] | null> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.indexPath, 'utf-8');
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    return parseWorkUnitIndexContent(content, this.indexPath);
  }

  /**
   * 锁内追加索引行（#524 P1-2）：upsert 快照行 / 删除墓碑行。
   * 追加前必要时做旧格式一次性迁移；追加后做定期压实评估。
   * 仅供已持有 this.lockDir 的路径调用（所有公共写路径都在 flock 内）。
   */
  private async appendIndexRowsLocked(rows: Array<WorkUnitSnapshot | WorkUnitIndexTombstone>): Promise<void> {
    await this.migrateLegacyIndexLocked();
    for (const row of rows) {
      await this.ctx.io.appendJsonl(this.indexPath, row);
    }
    this.indexAppendCount += rows.length;
    await this.compactIndexIfNeededLocked();
    this.indexVersion += 1;
  }

  /**
   * 旧格式（JSON 数组）一次性迁移：首个 append 前锁内重写为 JSONL。
   * 首 4KB peek 判定（O(1)，新格式行首必为 '{'）；旧数组严格解析（撕裂抛错，
   * 不静默当空）→ writeJsonl 原子重写。
   */
  private async migrateLegacyIndexLocked(): Promise<void> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.indexPath, 'r');
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return;
      throw err;
    }
    let legacy = false;
    try {
      const size = (await handle.stat()).size;
      if (size > 0) {
        const buf = Buffer.alloc(Math.min(4096, size));
        // 本包 @types/node 钉在 20.0.0，与 TS 5.7+ lib 的 ArrayBufferView 泛型不兼容——
        // 仅做类型层适配（同 jsonl-tail.ts 先例）
        await handle.read(buf as Uint8Array, 0, buf.length, 0);
        legacy = buf.toString('utf8').trimStart().startsWith('[');
      }
    } finally {
      await handle.close();
    }
    if (!legacy) return;
    const snapshots = parseWorkUnitIndexContent(await fs.promises.readFile(this.indexPath, 'utf-8'), this.indexPath);
    await this.ctx.io.writeJsonl(this.indexPath, snapshots);
    this.indexVersion += 1;
  }

  /** 定期压实评估（锁内）：行数 ≥ minLines 且死行占比 ≥ deadRatio → 重写为 fold 后 JSONL */
  private async compactIndexIfNeededLocked(): Promise<void> {
    if (this.indexAppendCount % this.indexCompaction.checkInterval !== 0) return;
    let content: string;
    try {
      content = await fs.promises.readFile(this.indexPath, 'utf-8');
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return;
      throw err;
    }
    const rawLines = content.split('\n').filter(l => l.trim().length > 0).length;
    if (rawLines < this.indexCompaction.minLines) return;
    const folded = parseWorkUnitIndexContent(content, this.indexPath);
    if ((rawLines - folded.length) / rawLines < this.indexCompaction.deadRatio) return;
    await this.ctx.io.writeJsonl(this.indexPath, folded);
  }

  /**
   * getIndex 的读路径（#314 D1）：mtime 校验的读穿缓存（锁外只读场景跨进程安全；
   * #681 组合化后为唯一实现，不再有「基类裸读缺省 + 覆盖」双形态）。
   * 保留 readIndexFile 的严格损坏语义（撕裂/非数组抛错，不静默当空），
   * 命中返回结构克隆。锁内当前态点查走 current projection，不经过本方法。
   * #406：filter 下推——命中路径在共享缓存数组上按引用选行、只克隆命中行
   * （monitor 等带 status 过滤的读口不再为丢弃的行付克隆税）；无 filter 时
   * 全量克隆，与 #314 行为一致。
   */
  private async readIndexForQuery(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[] | null> {
    const filePath = this.indexPath;
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      // 共享缓存数组上按引用选行（applyFilter 不 mutate），克隆只发生在命中子集上
      const matched = hit.value === null ? null : applyFilter(hit.value as WorkUnitSnapshot[], filter);
      const cached = cloneCached(matched) as WorkUnitSnapshot[] | null;
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    let value: WorkUnitSnapshot[] | null;
    if (this.indexReadFlight) {
      value = await this.indexReadFlight;
    } else {
      const flight = this.readIndexFile();
      this.indexReadFlight = flight;
      try {
        value = await flight;
      } finally {
        if (this.indexReadFlight === flight) this.indexReadFlight = null;
      }
    }
    const t2 = t?.() ?? 0;
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    const cloned = cloneCached(value === null ? null : applyFilter(value, filter)) as WorkUnitSnapshot[] | null;
    if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }

  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    return (await this.readIndexForQuery(filter)) ?? [];
  }

  /** O(1) 本进程写版本；不是跨进程序列号，外部写由调用方周期刷新与 mtime 读穿发现。 */
  getIndexVersion(): number {
    return this.indexVersion;
  }

  /**
   * 事件流 → 快照 Map 归约（rebuildIndex 与 reconcileIndex 共用）。
   * #170（决策 #65-3）：data.deleted === true 的 closed 事件 = 删除墓碑——
   * 快照从归约结果移除（delete/GC 路径经 commitRemoval 落墓碑，对账/重建不复活已删 WU）。
   *
   * #360 注记：不接线共享 foldJsonlById——本处是事件归约 merge 语义（字段级
   * 合并累进快照），foldJsonlById 是「每组取最新一行」覆盖语义，口径不同。
   */
  private reduceEventsToSnapshots(events: WorkUnitEvent[]): Map<string, WorkUnitSnapshot> {
    const snapshotMap = new Map<string, WorkUnitSnapshot>();
    const merge = (event: WorkUnitEvent): void => {
      const existing = snapshotMap.get(event.wuId);
      if (existing && event.data) {
        snapshotMap.set(event.wuId, { ...existing, ...event.data as Partial<WorkUnitSnapshot> } as WorkUnitSnapshot);
      }
    };

    for (const event of events) {
      switch (event.type) {
        case 'created':
          snapshotMap.set(event.wuId, event.data as unknown as WorkUnitSnapshot);
          break;
        case 'closed':
          // 删除墓碑优先于普通合并（commitRemoval 落的 closed + deleted 标记）
          if (event.data && (event.data as Record<string, unknown>).deleted === true) {
            snapshotMap.delete(event.wuId);
          } else {
            merge(event);
          }
          break;
        case 'claimed':
        case 'updated':
        case 'completed':
        case 'blocked':
          merge(event);
          break;
      }
    }

    return snapshotMap;
  }

  /**
   * 锁内读取 events 完整提交 head；dev:ino 识别轮转/替换。
   * 尾部不是换行 = 上次 append 崩溃半行：fail-closed，禁止把半行提交进 manifest
   * 或在半行后继续粘连 append。调用方/运维截断未提交半行后可自动恢复。
   */
  private async readLogPositionLocked(): Promise<WorkUnitLogPosition> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.eventsPath, 'r');
    } catch (error) {
      if (isErrnoError(error) && error.code === 'ENOENT') return { dev: 0, ino: 0, offset: 0 };
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last as Uint8Array, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) {
          throw new Error(`WorkUnit event log incomplete trailing line (truncate the uncommitted tail before retry): ${this.eventsPath}`);
        }
      }
      return { dev: stat.dev, ino: stat.ino, offset: stat.size };
    } finally {
      await handle.close();
    }
  }

  private async readCurrentManifestLocked(): Promise<WorkUnitCurrentManifest | null> {
    try {
      return parseWorkUnitCurrentManifest(
        await fs.promises.readFile(this.currentManifestPath, 'utf8'),
        this.currentManifestPath,
      );
    } catch (error) {
      if (isErrnoError(error) && error.code !== 'ENOENT') throw error;
      return null; // 缺失或损坏均走事件流重建
    }
  }

  private async hasLegacyPendingLocked(): Promise<boolean> {
    try {
      await fs.promises.stat(this.legacyPendingPath);
      return true;
    } catch (error) {
      if (isErrnoError(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  private async clearLegacyPendingLocked(): Promise<void> {
    await fs.promises.unlink(this.legacyPendingPath).catch(error => {
      if (!isErrnoError(error) || error.code !== 'ENOENT') throw error;
    });
  }

  /** 所有 events 重建/append 前的统一闸门：先保住 index 中的 legacy 直写。 */
  private async recoverLegacyPendingLocked(): Promise<WorkUnitCurrentManifest | null> {
    if (!await this.hasLegacyPendingLocked()) return null;
    const snapshots = (await this.readIndexFile()) ?? [];
    const manifest = await this.replaceCurrentLocked(snapshots);
    await this.clearLegacyPendingLocked(); // replace 完整提交前保留 pending，恢复可重复
    return manifest;
  }

  private async ensureCurrentLocked(): Promise<WorkUnitCurrentManifest> {
    const recovered = await this.recoverLegacyPendingLocked();
    if (recovered) return recovered;
    const head = await this.readLogPositionLocked();
    const manifest = await this.readCurrentManifestLocked();
    if (manifest && sameWorkUnitLogPosition(manifest.log, head)) return manifest;
    return this.rebuildCurrentLocked();
  }

  /**
   * 全量恢复只发生在首次升级、崩溃/代际失配或显式重建。
   * 无事件的 legacy/直写 index 数据从 index  bootstrap；有事件时 events 永远是真源。
   */
  private async rebuildCurrentLocked(): Promise<WorkUnitCurrentManifest> {
    const events = await this.ctx.base.readJsonl<WorkUnitEvent>(this.eventsPath);
    let snapshots: WorkUnitSnapshot[];
    if (events.length > 0) {
      snapshots = Array.from(this.reduceEventsToSnapshots(events).values());
      await this.ctx.io.writeJsonl(this.indexPath, snapshots);
      this.indexVersion += 1;
    } else {
      snapshots = (await this.readIndexFile()) ?? [];
    }
    return this.replaceCurrentLocked(snapshots);
  }

  /** 并行派生写必须全部 settled 后才能抛错放锁；任一失败不取消、不吞错。 */
  private async settleCurrentWritesLocked(writes: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(writes);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  private async replaceCurrentLocked(snapshots: WorkUnitSnapshot[]): Promise<WorkUnitCurrentManifest> {
    await this.ctx.base.ensureDir(this.currentDir);
    await this.ctx.base.ensureDir(this.currentHeadsDir);
    const head = await this.readLogPositionLocked();
    const expectedFiles = new Set(snapshots.map(snapshot => workUnitProjectionFileName(snapshot.id)));
    // 全量恢复允许 O(active WU)，但串行 fsync 会让其他进程超过 5s 锁预算；有界并行缩短持锁窗口。
    const batchSize = 32;
    for (let offset = 0; offset < snapshots.length; offset += batchSize) {
      const writes = snapshots.slice(offset, offset + batchSize).flatMap(snapshot => {
        const fileName = workUnitProjectionFileName(snapshot.id);
        return [
          this.ctx.io.writeJson(path.join(this.currentDir, fileName), {
            version: 1, log: head, snapshot,
          }, false),
          this.ctx.io.writeJson(path.join(this.currentHeadsDir, fileName), { version: 1, log: head }, false),
        ];
      });
      await this.settleCurrentWritesLocked(writes);
    }
    for (const entry of await fs.promises.readdir(this.currentDir)) {
      if (entry.endsWith('.json') && entry !== 'manifest.json' && entry !== 'legacy-pending.json' && !expectedFiles.has(entry)) {
        await fs.promises.unlink(path.join(this.currentDir, entry));
      }
    }
    for (const entry of await fs.promises.readdir(this.currentHeadsDir)) {
      if (entry.endsWith('.json') && !expectedFiles.has(entry)) {
        await fs.promises.unlink(path.join(this.currentHeadsDir, entry));
      }
    }
    const manifest: WorkUnitCurrentManifest = { version: 1, log: head, count: snapshots.length };
    await this.ctx.io.writeJson(this.currentManifestPath, manifest); // 最后提交
    return manifest;
  }

  /** 正常增量写：projection/head 先于 manifest；beforeManifest 可屏障并行的 index 派生写。 */
  private async finalizeCurrentLocked(
    rows: Array<WorkUnitSnapshot | WorkUnitIndexTombstone>,
    beforeManifest?: Promise<unknown>,
  ): Promise<void> {
    const head = await this.readLogPositionLocked();
    const previous = await this.readCurrentManifestLocked();
    if (!previous) throw new Error(`WorkUnit current manifest missing before commit: ${this.currentManifestPath}`);
    let count = previous.count;
    for (const row of rows) {
      const projectionPath = this.currentProjectionPath(row.id);
      const headPath = this.currentHeadPath(row.id);
      let exists = true;
      try {
        await fs.promises.stat(projectionPath);
      } catch (error) {
        if (!isErrnoError(error) || error.code !== 'ENOENT') throw error;
        exists = false;
      }
      if ((row as WorkUnitIndexTombstone).deleted === true) {
        if (exists) count--;
        await this.settleCurrentWritesLocked([projectionPath, headPath].map(filePath =>
          fs.promises.unlink(filePath).catch(error => {
            if (!isErrnoError(error) || error.code !== 'ENOENT') throw error;
          })));
      } else {
        if (!exists) count++;
        await this.settleCurrentWritesLocked([
          this.ctx.io.writeJson(projectionPath, {
            version: 1, log: head, snapshot: row as WorkUnitSnapshot,
          }, false),
          this.ctx.io.writeJson(headPath, { version: 1, log: head }, false),
        ]);
      }
    }
    if (beforeManifest) await beforeManifest;
    await this.ctx.io.writeJson(this.currentManifestPath, { version: 1, log: head, count });
  }

  private async readCurrentSnapshotLocked(
    wuId: string,
    _manifest: WorkUnitCurrentManifest,
    allowRebuild = true,
  ): Promise<WorkUnitSnapshot | null> {
    const projectionPath = this.currentProjectionPath(wuId);
    const headPath = this.currentHeadPath(wuId);
    try {
      const projectionHead = parseWorkUnitProjectionHead(await fs.promises.readFile(headPath, 'utf8'), headPath);
      const projection = parseWorkUnitCurrentProjection(
        await fs.promises.readFile(projectionPath, 'utf8'),
        wuId,
        projectionHead,
        projectionPath,
      );
      return projection.snapshot;
    } catch (error) {
      if (isErrnoError(error) && error.code !== 'ENOENT') throw error;
      if (!allowRebuild) {
        if (isErrnoError(error) && error.code === 'ENOENT') return null;
        throw error;
      }
      // 已有事件的 projection 缺失不能冒充 WU 不存在；重建后仍缺失才返回 null。
      const rebuilt = await this.rebuildCurrentLocked();
      return this.readCurrentSnapshotLocked(wuId, rebuilt, false);
    }
  }

  /** guarded create 需要全当前态；枚举 projection，不 fold 历史 index。 */
  private async readAllCurrentSnapshotsLocked(
    manifest: WorkUnitCurrentManifest,
    allowRebuild = true,
  ): Promise<WorkUnitSnapshot[]> {
    try {
      const entries = await fs.promises.readdir(this.currentDir);
      const projectionEntries = entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry));
      if (projectionEntries.length !== manifest.count) {
        throw new Error(`WorkUnit current projection count mismatch: ${this.currentDir}`);
      }
      return Promise.all(projectionEntries.map(async entry => {
        const projectionPath = path.join(this.currentDir, entry);
        const headPath = path.join(this.currentHeadsDir, entry);
        const [projectionHead, content] = await Promise.all([
          fs.promises.readFile(headPath, 'utf8').then(raw => parseWorkUnitProjectionHead(raw, headPath)),
          fs.promises.readFile(projectionPath, 'utf8'),
        ]);
        const raw = JSON.parse(content) as { snapshot?: { id?: unknown } };
        if (typeof raw.snapshot?.id !== 'string') throw new Error(`WorkUnit current projection id missing: ${projectionPath}`);
        return parseWorkUnitCurrentProjection(content, raw.snapshot.id, projectionHead, projectionPath).snapshot;
      }));
    } catch (error) {
      if (isErrnoError(error) || !allowRebuild) throw error;
      const rebuilt = await this.rebuildCurrentLocked();
      return this.readAllCurrentSnapshotsLocked(rebuilt, false);
    }
  }

  /** 聚合读当前态：枚举 PERF-02 projection，不 fold append-only index。 */
  async listCurrentSnapshots(): Promise<WorkUnitSnapshot[]> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      const manifest = await this.ensureCurrentLocked();
      return this.readAllCurrentSnapshotsLocked(manifest);
    });
  }

  async rebuildIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      const recovered = await this.recoverLegacyPendingLocked();
      if (recovered) {
        // 本次调用已按 index-fold 完成恢复；不得再按 events 覆盖 legacy 直写。
        return applyFilter((await this.readIndexFile()) ?? [], filter);
      }
      await this.readLogPositionLocked(); // 半行 fail-closed：任何派生写之前拒绝
      const events = await this.ctx.base.readJsonl<WorkUnitEvent>(this.eventsPath);
      const snapshots = Array.from(this.reduceEventsToSnapshots(events).values());
      await this.ctx.io.writeJsonl(this.indexPath, snapshots);
      this.indexVersion += 1;
      await this.replaceCurrentLocked(snapshots);
      return applyFilter(snapshots, filter);
    });
  }

  /**
   * opts.timeoutAt：认领即发租约的场景（service 层 claim）把它锁内一并写入
   * （claimEvent.data + index 行），消掉「claim 后再 update(timeoutAt)」的二次 flock
   * 与第二条 updated 事件（2026-09 channel 链路性能治理分项 3）。不传 = 不动原值。
   * opts.assigneeRoleId 双职：写入 WU 的角色冗余快照 + B6 指名守卫的认领方 roleId 判据。
   */
  async claimWorkUnit(wuId: string, assigneeId: string, opts?: { assigneeRoleId?: string | null; timeoutAt?: string | null }): Promise<boolean> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      const manifest = await this.ensureCurrentLocked();
      const wu = await this.readCurrentSnapshotLocked(wuId, manifest);
      if (!wu || wu.status !== 'unassigned') return false;

      // B6 指名守卫（锁内）：assigneeId 非空 = 已被指名（mention 落 profile id / 显式指派），
      // 只许同 id 认领方、或其 roleId 命中的运行实例（opts.assigneeRoleId）认领——
      // 其余拒绝（REST 人工认领抢不走指名单）。涌现认领（assigneeId 空）不受影响
      if (wu.assigneeId && wu.assigneeId !== assigneeId && wu.assigneeId !== (opts?.assigneeRoleId ?? null)) {
        return false;
      }

      const assigneeRoleId = opts?.assigneeRoleId ?? null;
      const timeoutAt = opts?.timeoutAt !== undefined ? opts.timeoutAt : wu.timeoutAt;
      const timestamp = new Date().toISOString();
      const claimEvent: WorkUnitEvent = {
        type: 'claimed',
        wuId,
        timestamp,
        data: { assigneeId, assigneeRoleId, status: 'active', claimedAt: timestamp, updatedAt: timestamp, timeoutAt },
      };
      const updated: WorkUnitSnapshot = {
        ...wu, assigneeId, assigneeRoleId, status: 'active', claimedAt: timestamp, updatedAt: timestamp, timeoutAt,
      };
      await this.ctx.io.appendJsonl(this.eventsPath, claimEvent);
      await this.appendIndexRowsLocked([updated]);
      await this.finalizeCurrentLocked([updated]);
      return true;
    });
  }

  /**
   * Upsert a single WorkUnit snapshot in index.json.
   * 用于 service 层 create/update 后同步更新快照。
   * #524 P1-2：append-only——锁内追加一行快照（替代 read-modify-write 全量重写），
   * 全程持有 workunits flock（与 claimWorkUnit 同一把锁），跨进程并发写不会丢更新。
   */
  async upsertSnapshot(snapshot: WorkUnitSnapshot): Promise<void> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      await this.ensureCurrentLocked();
      // legacy 无 events：pending 必须先于 index，否则崩溃无法区分新鲜旧 projection。
      await this.ctx.io.appendJsonl(this.legacyPendingPath, { version: 1, operation: 'upsert', id: snapshot.id });
      await this.upsertSnapshotLocked(snapshot);
      await this.finalizeCurrentLocked([snapshot]);
      await this.clearLegacyPendingLocked();
    });
  }

  /**
   * upsertSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用。
   * withLock（mkdir）不可重入，持锁方若调公共 upsertSnapshot 会自死锁。
   */
  private async upsertSnapshotLocked(snapshot: WorkUnitSnapshot): Promise<void> {
    // #524 P1-2：append-only upsert 行；旧格式首个写自动迁移，损坏抛错在迁移/fold 内
    await this.appendIndexRowsLocked([snapshot]);
  }

  /**
   * Remove a WorkUnit snapshot from index.json by id.
   * 用于 service 层 delete 后清理快照。
   * 与 upsertSnapshot 同一把 workunits flock。
   */
  async removeSnapshot(id: string): Promise<void> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      await this.ensureCurrentLocked();
      let hasIndex = true;
      try {
        await fs.promises.stat(this.indexPath);
      } catch (error) {
        if (!isErrnoError(error) || error.code !== 'ENOENT') throw error;
        hasIndex = false; // 不存在保持 no-op，不创建 pending/index
      }
      if (hasIndex) {
        await this.ctx.io.appendJsonl(this.legacyPendingPath, { version: 1, operation: 'remove', id });
      }
      await this.removeSnapshotLocked(id);
      if (hasIndex) await this.clearLegacyPendingLocked();
    });
  }

  /** removeSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用 */
  private async removeSnapshotLocked(id: string): Promise<void> {
    const tombstone: WorkUnitIndexTombstone = { id, deleted: true };
    // index 不存在 → 不创建索引；仍提交 projection head（commitRemoval 已追加墓碑事件）。
    try {
      await fs.promises.stat(this.indexPath);
    } catch (error) {
      if (isErrnoError(error) && error.code === 'ENOENT') {
        await this.finalizeCurrentLocked([tombstone]);
        return;
      }
      throw error;
    }
    await this.appendIndexRowsLocked([tombstone]);
    await this.finalizeCurrentLocked([tombstone]);
  }

  // ═══════════════════════
  // #170（决策 #65）锁内复合原语
  // ═══════════════════════

  /**
   * 锁内成对写（#65-3）：appendEvent + upsertSnapshotLocked 收进同一把 workunits flock，
   * 消除「事件已落、索引未更」的崩溃分叉窗口。所有任务写路径（create/update/状态迁移等）
   * 统一走本原语，不再锁外分两步。
   */
  async commitSnapshot(event: WorkUnitEvent, snapshot: WorkUnitSnapshot): Promise<void> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      await this.ensureCurrentLocked();
      await this.ctx.io.appendJsonl(this.eventsPath, event);
      const indexWrite = this.upsertSnapshotLocked(snapshot);
      await this.settleCurrentWritesLocked([
        indexWrite,
        this.finalizeCurrentLocked([snapshot], indexWrite),
      ]);
    });
  }

  /**
   * commitSnapshot 的删除变体：appendEvent（删除墓碑，closed + data.deleted=true）+
   * removeSnapshotLocked 同锁完成。墓碑保证 rebuildIndex / reconcileIndex 不复活已删 WU。
   */
  async commitRemoval(event: WorkUnitEvent, id: string): Promise<void> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      await this.ensureCurrentLocked();
      await this.ctx.io.appendJsonl(this.eventsPath, event);
      await this.removeSnapshotLocked(id);
    });
  }

  /**
   * #178（#63 决议 1/2）锁内租约心跳：fencing（claimedAt 代际令牌 + assigneeId 双比对）
   * 与 timeoutAt 推前的写入。事件 data 走增量（reduce 合并语义）。
   *
   * #314（D2）高频小写与快照落盘解耦：
   * - 本方法只做快速路 fencing（读 getIndex——mtime 校验读穿缓存，跨进程新鲜）+
   *   写内存 dirty 项，不再每跳读 index + 追加事件；
   * - 权威 fencing 复核与落盘（每 WU 一条增量事件 + 一行索引 append，#524 P1-2）
   *   收进 flushWorkUnitLeases 的同一把 workunits flock——#178「校验在锁内、
   *   与写入原子」的落点从「每跳」移到「每次落盘」；
   * - 距上次落盘 ≥ leaseFlushIntervalMs（默认 LEASE_FLUSH_INTERVAL_MS 60s）时顺带
   *   落盘（piggyback，到点的心跳负责 flush 全部 dirty 项）。持久化 timeoutAt 滞后
   *   ≤ flush 间隔 ≪ 5min TTL，活跃持有方不会被 timeout-release 误判到期。
   * @returns 'ok' = 已推前（缓冲）；'lost' = 易主（令牌/assignee 不匹配，一字未写）；'missing' = WU 不存在
   */
  async refreshWorkUnitLease(
    wuId: string,
    expectedAssigneeId: string,
    expectedClaimedAt: string,
    timeoutAt: Date,
  ): Promise<'ok' | 'lost' | 'missing'> {
    const current = (await this.getIndex({ id: wuId }))[0];
    if (!current) return 'missing';
    if (current.assigneeId !== expectedAssigneeId || current.claimedAt !== expectedClaimedAt) {
      this.pendingLeaseRefreshes.delete(wuId); // 令牌已失效，清掉残留 dirty 项
      return 'lost';
    }

    this.pendingLeaseRefreshes.set(wuId, {
      assigneeId: expectedAssigneeId,
      claimedAt: expectedClaimedAt,
      timeoutAt: timeoutAt.toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (Date.now() - this.lastLeaseFlushAt >= this.leaseFlushIntervalMs) {
      await this.flushWorkUnitLeases();
    }
    return 'ok';
  }

  /**
   * #314（D2）合并落盘：把所有缓冲的租约推前一次写盘。
   * workunits flock 内：逐 dirty 项裸读 per-WU current projection 复核 fencing +
   * status==='active'（易主/已删/已完成的丢弃，一字不写——zombie 推前不覆盖新 holder
   * 租约，完成 WU 的 updatedAt 不复活）→ 每 WU 追加一条增量 updated 事件 → 索引逐条
   * append → projection → manifest（事件最先、manifest 最后的崩溃恢复顺序）。
   * 测试/关停路径可显式调用；无 dirty 项时为 no-op（不取锁、不写盘）。
   */
  async flushWorkUnitLeases(): Promise<{ flushed: number; dropped: number }> {
    if (this.pendingLeaseRefreshes.size === 0) {
      this.lastLeaseFlushAt = Date.now();
      return { flushed: 0, dropped: 0 };
    }
    return this.ctx.base.withLock(this.lockDir, async () => {
      const manifest = await this.ensureCurrentLocked();
      let flushed = 0;
      let dropped = 0;
      const flushedRows: WorkUnitSnapshot[] = [];
      for (const [wuId, pending] of this.pendingLeaseRefreshes) {
        const current = await this.readCurrentSnapshotLocked(wuId, manifest);
        if (!current || current.status !== 'active'
          || current.assigneeId !== pending.assigneeId || current.claimedAt !== pending.claimedAt) {
          this.pendingLeaseRefreshes.delete(wuId);
          dropped++;
          continue;
        }
        const event: WorkUnitEvent = {
          type: 'updated',
          wuId,
          timestamp: pending.updatedAt,
          data: { timeoutAt: pending.timeoutAt, updatedAt: pending.updatedAt },
        };
        await this.ctx.io.appendJsonl(this.eventsPath, event);
        flushedRows.push({ ...current, timeoutAt: pending.timeoutAt, updatedAt: pending.updatedAt });
        this.pendingLeaseRefreshes.delete(wuId);
        flushed++;
      }

      if (flushedRows.length > 0) {
        await this.appendIndexRowsLocked(flushedRows);
        await this.finalizeCurrentLocked(flushedRows);
      }
      this.lastLeaseFlushAt = Date.now();
      return { flushed, dropped };
    });
  }

  /**
   * 锁内字段级 metadata 合并写（#65-1）：锁内读最新 metadata → 应用 mutator →
   * appendEvent('updated') + upsertSnapshotLocked 一次落盘。
   * 调用方（recordResult / pendingReplies 追加等）只把本步字段级增量交给 mutator，
   * 计数/数组类字段在锁内基于最新值计算，不再用读时快照全量回写（消读-改-写竞态）。
   * mutator 返回对象中 undefined 值的键在 JSON 序列化时丢弃 = 清除语义。
   * WU 不存在 → 返回 null（不抛错、不产生事件）；metadata 损坏按 {} 起评（parseWuMetadata 同口径）。
   * opts.touchUpdatedAt（缺省 true）：false 时保留原 updatedAt——#221 认领陈旧守卫的
   * 标记写专用，守卫写不能刷新 updatedAt（任何刷新 = 复活语义，守卫自己复活僵尸则防线失效）。
   */
  async updateMetadata(
    wuId: string,
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
    opts?: { touchUpdatedAt?: boolean },
  ): Promise<WorkUnitSnapshot | null> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      const manifest = await this.ensureCurrentLocked();
      const current = await this.readCurrentSnapshotLocked(wuId, manifest);
      if (!current) return null;

      const nextMeta = mutator(parseMetadataTolerant(current.metadata));
      const isoNow = new Date().toISOString();
      const updated: WorkUnitSnapshot = {
        ...current,
        metadata: JSON.stringify(nextMeta),
        updatedAt: opts?.touchUpdatedAt === false ? current.updatedAt : isoNow,
      };
      const event: WorkUnitEvent = {
        type: 'updated',
        wuId,
        timestamp: isoNow,
        data: updated as unknown as Record<string, unknown>,
      };
      await this.ctx.io.appendJsonl(this.eventsPath, event);
      await this.upsertSnapshotLocked(updated);
      await this.finalizeCurrentLocked([updated]);
      return updated;
    });
  }

  /**
   * 锁内 check-then-create（#65-2）：guard 在锁内对全量当前 projection 复查，
   * 通过才 appendEvent('created') + upsertSnapshotLocked；不 fold 历史 index。
   * @returns true = 已建单；false = guard 拒绝（未落事件、未落索引）
   */
  async createSnapshotGuarded(
    snapshot: WorkUnitSnapshot,
    guard: (snapshots: WorkUnitSnapshot[]) => boolean,
  ): Promise<boolean> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      const manifest = await this.ensureCurrentLocked();
      const snapshots = await this.readAllCurrentSnapshotsLocked(manifest);
      if (!guard(snapshots)) return false;
      const event: WorkUnitEvent = {
        type: 'created',
        wuId: snapshot.id,
        timestamp: new Date().toISOString(),
        data: snapshot as unknown as Record<string, unknown>,
      };
      await this.ctx.io.appendJsonl(this.eventsPath, event);
      await this.upsertSnapshotLocked(snapshot);
      await this.finalizeCurrentLocked([snapshot]);
      return true;
    });
  }

  /**
   * 启动对账（#65-3）：events vs index 全量比对（同 id 深度相等），不一致即按事件流
   * 重建索引并返回 rebuilt=true（调用方据此告警，出口按 #62 决议走告警频道）。
   * 历史数据可能已分叉，不对账永远不可知；对账在同一把 flock 内进行，与写路径互斥。
   */
  async reconcileIndex(): Promise<WorkUnitReconcileResult> {
    return this.ctx.base.withLock(this.lockDir, async () => {
      const recovered = await this.recoverLegacyPendingLocked();
      if (recovered) {
        // consistent 表示本次 index/current 已恢复一致；不把无 events 的 legacy 误判为 stale。
        const events = await this.ctx.base.readJsonl<WorkUnitEvent>(this.eventsPath);
        return {
          consistent: true, rebuilt: true, eventCount: events.length, indexCount: recovered.count,
          missingInIndex: 0, staleInIndex: 0, diverged: 0,
        };
      }
      await this.readLogPositionLocked();
      const events = await this.ctx.base.readJsonl<WorkUnitEvent>(this.eventsPath);
      const expected = this.reduceEventsToSnapshots(events);
      const index = (await this.readIndexFile()) ?? [];
      const indexById = new Map(index.map(s => [s.id, s]));

      let missingInIndex = 0;
      let staleInIndex = 0;
      let diverged = 0;
      for (const [id, snap] of expected) {
        const current = indexById.get(id);
        if (!current) missingInIndex++;
        else if (!isDeepStrictEqual(current, snap)) diverged++;
      }
      for (const s of index) {
        if (!expected.has(s.id)) staleInIndex++;
      }

      const consistent = missingInIndex === 0 && staleInIndex === 0 && diverged === 0;
      if (!consistent) {
        const snapshots = Array.from(expected.values());
        await this.ctx.io.writeJsonl(this.indexPath, snapshots);
        this.indexVersion += 1;
        await this.replaceCurrentLocked(snapshots);
      } else {
        await this.ensureCurrentLocked();
      }
      return {
        consistent,
        rebuilt: !consistent,
        eventCount: events.length,
        indexCount: index.length,
        missingInIndex,
        staleInIndex,
        diverged,
      };
    });
  }
}

/** reconcileIndex 的对账报告（#170） */
export interface WorkUnitReconcileResult {
  consistent: boolean;
  rebuilt: boolean;
  eventCount: number;
  indexCount: number;
  /** 事件流有、索引无（崩溃分叉丢失的索引更新） */
  missingInIndex: number;
  /** 索引有、事件流无（无事件的直写/幻影条目） */
  staleInIndex: number;
  /** 同 id 但内容不一致（索引陈旧） */
  diverged: number;
}

/** metadata JSON 串容错解析：null/空串/坏 JSON/非对象一律 {}（与 wu-metadata.parseWuMetadata 同口径） */
function parseMetadataTolerant(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** getIndex/filter 下推共用的快照选行口径（#406）：seam 与缓存命中路径共用，改口径只改这里 */
export function applyFilter(snapshots: WorkUnitSnapshot[], filter?: WorkUnitFilter): WorkUnitSnapshot[] {
  if (!filter) return snapshots;
  return snapshots.filter(s => {
    if (filter.id && s.id !== filter.id) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.statuses && !filter.statuses.includes(s.status)) return false;
    if (filter.type && s.type !== filter.type) return false;
    if (filter.assigneeId && s.assigneeId !== filter.assigneeId) return false;
    if (filter.channelId && s.channelId !== filter.channelId) return false;
    return true;
  });
}
