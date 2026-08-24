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

/** FileStoreWorkUnitBase 构造选项 */
export interface FileStoreWorkUnitOptions {
  /** 租约推前的落盘间隔（测试注入 0 = 每跳即落盘的即时持久化契约） */
  leaseFlushIntervalMs?: number;
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

  constructor(baseDir?: string, opts?: FileStoreWorkUnitOptions) {
    super(baseDir);
    this.leaseFlushIntervalMs = opts?.leaseFlushIntervalMs ?? LEASE_FLUSH_INTERVAL_MS;
    this.lastLeaseFlushAt = Date.now();
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
   * 读取 workunits/index.json 原始快照数组。
   * 文件不存在 → null（调用方按空处理）；存在但 JSON 撕裂/非数组 → 抛出带路径的错误。
   * 损坏绝不静默当空数组——防止后续基于空数组回写把全部已有快照抹掉。
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `WorkUnit index corrupted (JSON parse failed): ${this.indexPath}` +
        `${err instanceof Error ? ` — ${err.message}` : ''}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`WorkUnit index corrupted (not an array): ${this.indexPath}`);
    }
    return parsed as WorkUnitSnapshot[];
  }

  /**
   * getIndex 的读路径 seam（#314 D1）：基类缺省 = readIndexFile 裸读；
   * 门面 FileStore 覆盖为 mtime 校验的读穿缓存（锁外只读场景跨进程安全）。
   * 锁内读路径（claim/upsert/flush/updateMetadata/createSnapshotGuarded/reconcile）
   * 永远直调 readIndexFile，不经本 seam。
   */
  protected async readIndexForQuery(): Promise<WorkUnitSnapshot[] | null> {
    return this.readIndexFile();
  }

  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    const snapshots = (await this.readIndexForQuery()) ?? [];
    return applyFilter(snapshots, filter);
  }

  /**
   * 事件流 → 快照 Map 归约（rebuildIndex 与 reconcileIndex 共用）。
   * #170（决策 #65-3）：data.deleted === true 的 closed 事件 = 删除墓碑——
   * 快照从归约结果移除（delete/GC 路径经 commitRemoval 落墓碑，对账/重建不复活已删 WU）。
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

    // 写回 index.json
    await this.writeJson(this.indexPath, snapshots);

    return applyFilter(snapshots, filter);
  }

  async claimWorkUnit(wuId: string, assigneeId: string): Promise<boolean> {
    return this.withLock(this.lockDir, async () => {
      // 读取当前 index（不存在 → 空；撕裂/损坏 → 抛错，不再幻影 "not found"）
      const snapshots = (await this.readIndexFile()) ?? [];

      const wu = snapshots.find(s => s.id === wuId);
      if (!wu || wu.status !== 'unassigned') {
        return false;
      }

      // append claim event
      const timestamp = new Date().toISOString();
      const claimEvent: WorkUnitEvent = {
        type: 'claimed',
        wuId,
        timestamp,
        data: {
          assigneeId,
          status: 'active',
          claimedAt: timestamp,
          updatedAt: timestamp,
        },
      };
      await this.appendJsonl(this.eventsPath, claimEvent);

      // update index snapshot
      const updated = snapshots.map(s =>
        s.id === wuId
          ? { ...s, assigneeId, status: 'active' as const, claimedAt: timestamp, updatedAt: timestamp }
          : s
      );
      await this.writeJson(this.indexPath, updated);

      return true;
    });
  }

  /**
   * Upsert a single WorkUnit snapshot in index.json.
   * 用于 service 层 create/update 后同步更新快照。
   * read-modify-write 全程持有 workunits flock（与 claimWorkUnit 同一把锁），
   * 跨进程并发写不会丢更新。
   */
  async upsertSnapshot(snapshot: WorkUnitSnapshot): Promise<void> {
    return this.withLock(this.lockDir, () => this.upsertSnapshotLocked(snapshot));
  }

  /**
   * upsertSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用。
   * withLock（mkdir）不可重入，持锁方若调公共 upsertSnapshot 会自死锁。
   */
  private async upsertSnapshotLocked(snapshot: WorkUnitSnapshot): Promise<void> {
    // index 不存在 → 从空开始；撕裂/损坏 → 抛错，绝不基于空数组回写
    const snapshots = (await this.readIndexFile()) ?? [];
    const idx = snapshots.findIndex(s => s.id === snapshot.id);
    if (idx >= 0) {
      snapshots[idx] = snapshot;
    } else {
      snapshots.push(snapshot);
    }
    await this.writeJson(this.indexPath, snapshots);
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
    // index 不存在 → nothing to remove；撕裂/损坏 → 抛错
    const snapshots = await this.readIndexFile();
    if (!snapshots) return;
    const filtered = snapshots.filter(s => s.id !== id);
    await this.writeJson(this.indexPath, filtered);
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
   * #314（D2）高频小写与全量快照写解耦：
   * - 本方法只做快速路 fencing（读 getIndex——mtime 校验读穿缓存，跨进程新鲜）+
   *   写内存 dirty 项，不再每跳全量读 2 次 + 全量重写 index + 追加事件；
   * - 权威 fencing 复核与落盘（每 WU 一条增量事件 + 全量索引一次写）收进
   *   flushWorkUnitLeases 的同一把 workunits flock——#178「校验在锁内、与写入原子」
   *   的落点从「每跳」移到「每次落盘」；
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
    const snapshots = await this.getIndex();
    const current = snapshots.find(s => s.id === wuId);
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
   * updated 事件（事件先于索引写，同 commitSnapshot 崩溃恢复顺序）→ 全量索引一次写。
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
        snapshots[idx] = { ...current, timeoutAt: pending.timeoutAt, updatedAt: pending.updatedAt };
        this.pendingLeaseRefreshes.delete(wuId);
        flushed++;
        changed = true;
      }

      if (changed) {
        await this.writeJson(this.indexPath, snapshots);
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
        await this.writeJson(this.indexPath, Array.from(expected.values()));
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

function applyFilter(snapshots: WorkUnitSnapshot[], filter?: WorkUnitFilter): WorkUnitSnapshot[] {
  if (!filter) return snapshots;
  return snapshots.filter(s => {
    if (filter.status && s.status !== filter.status) return false;
    if (filter.type && s.type !== filter.type) return false;
    if (filter.assigneeId && s.assigneeId !== filter.assigneeId) return false;
    if (filter.channelId && s.channelId !== filter.channelId) return false;
    return true;
  });
}
