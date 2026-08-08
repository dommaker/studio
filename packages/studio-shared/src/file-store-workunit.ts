/**
 * FileStoreWorkUnitBase — FileStore 的 WorkUnit 事件溯源层（从 file-store.ts 抽出）
 *
 * events.jsonl 事件流 + index.json 快照的读写、claim/upsert/remove 的 flock 互斥。
 * 继承 FileStoreBase 的原子读写与 withLock；门面 FileStore 再继承本类。
 */

import fs from 'node:fs';
import path from 'node:path';
import { FileStoreBase, isErrnoError } from './file-store-base';
import type { WorkUnitEvent, WorkUnitSnapshot, WorkUnitFilter } from './file-store-types';

export class FileStoreWorkUnitBase extends FileStoreBase {
  private get lockDir(): string {
    return path.join(this.baseDir, 'workunits', 'lock');
  }

  private get eventsPath(): string {
    return path.join(this.baseDir, 'workunits', 'events.jsonl');
  }

  private get indexPath(): string {
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
   */
  private async readIndexFile(): Promise<WorkUnitSnapshot[] | null> {
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

  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    const snapshots = (await this.readIndexFile()) ?? [];
    return applyFilter(snapshots, filter);
  }

  async rebuildIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    const events = await this.readJsonl<WorkUnitEvent>(this.eventsPath);
    const snapshotMap = new Map<string, WorkUnitSnapshot>();

    for (const event of events) {
      switch (event.type) {
        case 'created':
          snapshotMap.set(event.wuId, event.data as unknown as WorkUnitSnapshot);
          break;
        case 'claimed':
        case 'updated':
        case 'completed':
        case 'closed':
        case 'blocked': {
          const existing = snapshotMap.get(event.wuId);
          if (existing && event.data) {
            snapshotMap.set(event.wuId, { ...existing, ...event.data as Partial<WorkUnitSnapshot> } as WorkUnitSnapshot);
          }
          break;
        }
      }
    }

    const snapshots = Array.from(snapshotMap.values());

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
