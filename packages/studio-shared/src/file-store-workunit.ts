/**
 * FileStoreWorkUnitBase — FileStore 的 WorkUnit 事件溯源层（从 file-store.ts 抽出）
 *
 * events.jsonl 事件流 + index.json 快照的读写、claim/upsert/remove 的 flock 互斥。
 * 继承 FileStoreBase 的原子读写与 withLock；门面 FileStore 再继承本类。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileStoreBase, isErrnoError } from './file-store-base';
import type { WorkUnitEvent, WorkUnitSnapshot, WorkUnitFilter } from './file-store-types';

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

/** FileStoreWorkUnitBase 构造选项 */
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

export class FileStoreWorkUnitBase extends FileStoreBase {
  private readonly leaseFlushIntervalMs: number;
  /** 上次落盘时刻；初始化为构造时刻（首个落盘窗口自实例创建起算，语义无害） */
  private lastLeaseFlushAt: number;
  private readonly pendingLeaseRefreshes = new Map<string, PendingLeaseRefresh>();
  /** #524 P1-2：index 压实阈值与 append 计数（进程内存，重启清零最多延迟一轮评估——同 #319 先例） */
  private readonly indexCompaction: Required<IndexCompactionOptions>;
  private indexAppendCount = 0;

  constructor(baseDir?: string, opts?: FileStoreWorkUnitOptions) {
    super(baseDir);
    this.leaseFlushIntervalMs = opts?.leaseFlushIntervalMs ?? LEASE_FLUSH_INTERVAL_MS;
    this.lastLeaseFlushAt = Date.now();
    this.indexCompaction = {
      checkInterval: opts?.indexCompaction?.checkInterval ?? INDEX_COMPACT_CHECK_INTERVAL,
      minLines: opts?.indexCompaction?.minLines ?? INDEX_COMPACT_MIN_LINES,
      deadRatio: opts?.indexCompaction?.deadRatio ?? INDEX_COMPACT_DEAD_RATIO,
    };
  }

  private get lockDir(): string {
    return path.join(this.baseDir, 'workunits', 'lock');
  }

  private get eventsPath(): string {
    return path.join(this.baseDir, 'workunits', 'events.jsonl');
  }

  protected get indexPath(): string {
    return path.join(this.baseDir, 'workunits', 'index.json');
  }

  // ═══════════════════════
  // WorkUnit Event Sourcing
  // ═══════════════════════

  async appendEvent(event: WorkUnitEvent): Promise<void> {
    await this.appendJsonl(this.eventsPath, event);
  }

  /**
   * 读取 workunits/index.json 快照数组（双格式 fold，口径 = parseWorkUnitIndexContent）。
   * 文件不存在 → null（调用方按空处理）。旧格式（JSON 数组）撕裂/非数组、
   * JSONL 缺 id 行 → 抛出带路径的错误（损坏绝不静默当空——防止后续基于空数组
   * 回写把全部已有快照抹掉）；JSONL 撕裂尾行跳过（append 崩溃容错，
   * events 是正本，reconcileIndex 兜底）。
   * 永远裸读（不走缓存）：锁内路径要求跨进程实时性。锁外只读的 getIndex
   * 经 readIndexForQuery seam 由门面覆盖为读穿缓存（#314 D1）。
   */
  protected async readIndexFile(): Promise<WorkUnitSnapshot[] | null> {
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
      await this.appendJsonl(this.indexPath, row);
    }
    this.indexAppendCount += rows.length;
    await this.compactIndexIfNeededLocked();
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
    await this.writeJsonl(this.indexPath, snapshots);
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
    await this.writeJsonl(this.indexPath, folded);
  }

  /**
   * getIndex 的读路径 seam（#314 D1）：基类缺省 = readIndexFile 裸读 + 按 filter 选行；
   * 门面 FileStore 覆盖为 mtime 校验的读穿缓存（锁外只读场景跨进程安全）。
   * 锁内读路径（claim/upsert/flush/updateMetadata/createSnapshotGuarded/reconcile）
   * 永远直调 readIndexFile，不经本 seam（#314 D1 例外条款不受下推影响）。
   */
  protected async readIndexForQuery(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[] | null> {
    const snapshots = await this.readIndexFile();
    return snapshots === null ? null : applyFilter(snapshots, filter);
  }

  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    return (await this.readIndexForQuery(filter)) ?? [];
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

  async rebuildIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    const events = await this.readJsonl<WorkUnitEvent>(this.eventsPath);
    const snapshots = Array.from(this.reduceEventsToSnapshots(events).values());

    // 写回 index.json（#524 P1-2：JSONL 压实写 = 派生物全量重建）
    await this.writeJsonl(this.indexPath, snapshots);

    return applyFilter(snapshots, filter);
  }

  async claimWorkUnit(wuId: string, assigneeId: string, opts?: { assigneeRoleId?: string | null }): Promise<boolean> {
    return this.withLock(this.lockDir, async () => {
      // 读取当前 index（不存在 → 空；撕裂/损坏 → 抛错，不再幻影 "not found"）
      const snapshots = (await this.readIndexFile()) ?? [];

      const wu = snapshots.find(s => s.id === wuId);
      if (!wu || wu.status !== 'unassigned') {
        return false;
      }

      // 认领时冗余 assigneeRoleId 快照：实例回收后展示层仍能解析角色名
      const assigneeRoleId = opts?.assigneeRoleId ?? null;

      // append claim event
      const timestamp = new Date().toISOString();
      const claimEvent: WorkUnitEvent = {
        type: 'claimed',
        wuId,
        timestamp,
        data: {
          assigneeId,
          assigneeRoleId,
          status: 'active',
          claimedAt: timestamp,
          updatedAt: timestamp,
        },
      };
      await this.appendJsonl(this.eventsPath, claimEvent);

      // #524 P1-2：index append-only——追加一行更新后快照，不再全量重写
      await this.appendIndexRowsLocked([
        { ...wu, assigneeId, assigneeRoleId, status: 'active' as const, claimedAt: timestamp, updatedAt: timestamp },
      ]);

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
    return this.withLock(this.lockDir, () => this.upsertSnapshotLocked(snapshot));
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
    return this.withLock(this.lockDir, () => this.removeSnapshotLocked(id));
  }

  /** removeSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用 */
  private async removeSnapshotLocked(id: string): Promise<void> {
    // index 不存在 → nothing to remove（不创建文件）；撕裂/损坏 → 抛错
    const snapshots = await this.readIndexFile();
    if (!snapshots) return;
    // #524 P1-2：追加墓碑行（fold 时整条移除；rebuildIndex/reconcileIndex 不复活）
    await this.appendIndexRowsLocked([{ id, deleted: true }]);
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
    return this.withLock(this.lockDir, async () => {
      await this.appendJsonl(this.eventsPath, event);
      await this.upsertSnapshotLocked(snapshot);
    });
  }

  /**
   * commitSnapshot 的删除变体：appendEvent（删除墓碑，closed + data.deleted=true）+
   * removeSnapshotLocked 同锁完成。墓碑保证 rebuildIndex / reconcileIndex 不复活已删 WU。
   */
  async commitRemoval(event: WorkUnitEvent, id: string): Promise<void> {
    return this.withLock(this.lockDir, async () => {
      await this.appendJsonl(this.eventsPath, event);
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
   * workunits flock 内：裸读最新索引（readIndexFile，锁内不缓存）→ 逐 dirty 项复核
   * fencing + status==='active'（易主/已删/已完成的丢弃，一字不写——zombie 推前
   * 不覆盖新 holder 租约，完成 WU 的 updatedAt 不复活）→ 每 WU 追加一条增量
   * updated 事件（事件先于索引写，同 commitSnapshot 崩溃恢复顺序）→ 索引逐条
   * append（#524 P1-2，替代全量重写）。
   * 测试/关停路径可显式调用；无 dirty 项时为 no-op（不取锁、不写盘）。
   */
  async flushWorkUnitLeases(): Promise<{ flushed: number; dropped: number }> {
    if (this.pendingLeaseRefreshes.size === 0) {
      this.lastLeaseFlushAt = Date.now();
      return { flushed: 0, dropped: 0 };
    }
    return this.withLock(this.lockDir, async () => {
      const snapshots = (await this.readIndexFile()) ?? [];
      let flushed = 0;
      let dropped = 0;
      let changed = false;

      const flushedRows: WorkUnitSnapshot[] = [];
      for (const [wuId, pending] of this.pendingLeaseRefreshes) {
        const idx = snapshots.findIndex(s => s.id === wuId);
        const current = idx >= 0 ? snapshots[idx] : undefined;
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
        await this.appendJsonl(this.eventsPath, event);
        flushedRows.push({ ...current, timeoutAt: pending.timeoutAt, updatedAt: pending.updatedAt });
        this.pendingLeaseRefreshes.delete(wuId);
        flushed++;
        changed = true;
      }

      if (changed) {
        // #524 P1-2：逐条 append 推前后快照，不再全量重写 index
        await this.appendIndexRowsLocked(flushedRows);
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
    return this.withLock(this.lockDir, async () => {
      const snapshots = (await this.readIndexFile()) ?? [];
      const current = snapshots.find(s => s.id === wuId);
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
      await this.appendJsonl(this.eventsPath, event);
      await this.upsertSnapshotLocked(updated);
      return updated;
    });
  }

  /**
   * 锁内 check-then-create（#65-2）：guard 在锁内对最新 index 复查，通过才
   * appendEvent('created') + upsertSnapshotLocked——并发下同守卫建单只有一个成功
   * （照抄 claimWorkUnit 锁内复查的既有模式）。review 建子 WU 的同父唯一性走本原语。
   * @returns true = 已建单；false = guard 拒绝（未落事件、未落索引）
   */
  async createSnapshotGuarded(
    snapshot: WorkUnitSnapshot,
    guard: (snapshots: WorkUnitSnapshot[]) => boolean,
  ): Promise<boolean> {
    return this.withLock(this.lockDir, async () => {
      const snapshots = (await this.readIndexFile()) ?? [];
      if (!guard(snapshots)) return false;
      const event: WorkUnitEvent = {
        type: 'created',
        wuId: snapshot.id,
        timestamp: new Date().toISOString(),
        data: snapshot as unknown as Record<string, unknown>,
      };
      await this.appendJsonl(this.eventsPath, event);
      await this.upsertSnapshotLocked(snapshot);
      return true;
    });
  }

  /**
   * 启动对账（#65-3）：events vs index 全量比对（同 id 深度相等），不一致即按事件流
   * 重建索引并返回 rebuilt=true（调用方据此告警，出口按 #62 决议走告警频道）。
   * 历史数据可能已分叉，不对账永远不可知；对账在同一把 flock 内进行，与写路径互斥。
   */
  async reconcileIndex(): Promise<WorkUnitReconcileResult> {
    return this.withLock(this.lockDir, async () => {
      const events = await this.readJsonl<WorkUnitEvent>(this.eventsPath);
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
        await this.writeJsonl(this.indexPath, Array.from(expected.values()));
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

/** getIndex/filter 下推共用的快照选行口径（#406）：seam 与门面缓存命中路径共用，改口径只改这里 */
export function applyFilter(snapshots: WorkUnitSnapshot[], filter?: WorkUnitFilter): WorkUnitSnapshot[] {
  if (!filter) return snapshots;
  return snapshots.filter(s => {
    if (filter.id && s.id !== filter.id) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.type && s.type !== filter.type) return false;
    if (filter.assigneeId && s.assigneeId !== filter.assigneeId) return false;
    if (filter.channelId && s.channelId !== filter.channelId) return false;
    return true;
  });
}
