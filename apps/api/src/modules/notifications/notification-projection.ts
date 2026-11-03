/**
 * PERF-05 通知当前态投影：小 manifest + per-entry + per-recipient view。
 * notifications.jsonl 是唯一真源；读取一个接收者不需要解析其他接收者或全量 entries。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileStore } from '@dommaker/studio-shared';

export interface NotificationRow {
  id: string;
  userId?: string;
  type?: string;
  title?: string;
  content?: string;
  link?: string;
  wuId?: string;
  channelId?: string;
  createdAt?: string;
  deleted?: boolean;
  deletedAt?: string;
}

export interface FoldedNotification {
  data: NotificationRow | null;
  read: boolean;
  readAt: string | null;
}

interface LogHead { dev: number; ino: number; offset: number }
export interface NotificationManifest { version: 3; head: LogHead | null; recipientIds: string[] }
export interface RecipientProjection { unreadCount: number; items: Record<string, FoldedNotification> }

const TAIL_CHUNK = 64 * 1024;
const EMPTY_MANIFEST: NotificationManifest = { version: 3, head: null, recipientIds: [] };
const emptyRecipient = (): RecipientProjection => ({ unreadCount: 0, items: {} });
const fileKey = (id: string): string => createHash('sha256').update(id).digest('hex');
class CorruptedNotificationEntry extends Error {}

async function committedOffset(handle: fs.promises.FileHandle, size: number): Promise<number> {
  if (size > 0) {
    const last = Buffer.alloc(1);
    const { bytesRead } = await handle.read(last, 0, 1, size - 1);
    if (bytesRead !== 1) throw new Error('Notification log truncated while locating committed offset');
    if (last[0] === 0x0a) return size;
  }
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) throw new Error('Notification log truncated while locating committed offset');
    const newline = buffer.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

export class NotificationProjection {
  readonly lockPath: string;
  private readonly projectionDir: string;
  private readonly manifestPath: string;
  private readonly entriesDir: string;
  private readonly recipientsDir: string;

  constructor(private readonly fileStore: FileStore, private readonly sourcePath: string) {
    this.lockPath = `${sourcePath}.lock`;
    this.projectionDir = path.join(path.dirname(sourcePath), 'projections', 'notifications');
    this.manifestPath = path.join(this.projectionDir, 'manifest.json');
    this.entriesDir = path.join(this.projectionDir, 'entries');
    this.recipientsDir = path.join(this.projectionDir, 'recipients');
  }

  /** 只同步小 manifest 与增量涉及的通知/接收者，不返回或解析全量 entries。 */
  async sync(): Promise<NotificationManifest> {
    let manifest = await this.readManifest();
    const handle = await fs.promises.open(this.sourcePath, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) {
      if (manifest.head !== null) manifest = await this.reset();
      return manifest;
    }

    try {
      const stat = await handle.stat();
      if (stat.size === 0) {
        if (manifest.head !== null) manifest = await this.reset();
        return manifest;
      }
      const current = { dev: stat.dev, ino: stat.ino, offset: await committedOffset(handle, stat.size) };
      if (!this.headUsable(manifest.head, current)) {
        await this.reset();
        manifest = { ...EMPTY_MANIFEST, recipientIds: [] };
      } else if (manifest.head?.offset === current.offset) {
        return manifest;
      }

      const recipientIds = new Set(manifest.recipientIds);
      try {
        const rows = await this.readDelta(handle, manifest.head?.offset ?? 0, current.offset);
        for (const row of rows) await this.applyRow(row, recipientIds);
      } catch (error) {
        if (!(error instanceof CorruptedNotificationEntry)) throw error;
        // entry 不可读时不能猜测 previous/接收者；丢弃派生物并从 0 重放真源。
        manifest = await this.reset();
        recipientIds.clear();
        const rows = await this.readDelta(handle, 0, current.offset);
        for (const row of rows) await this.applyRow(row, recipientIds);
      }
      manifest = { version: 3, head: current, recipientIds: [...recipientIds].sort() };
      await this.fileStore.writeJson(this.manifestPath, manifest);
      return manifest;
    } finally {
      await handle.close();
    }
  }

  async readRecipient(userId: string, syncedManifest?: NotificationManifest): Promise<RecipientProjection> {
    // 只有本次 sync 返回的可信 manifest 可提前判空；缺失/损坏 manifest 仍先尝试既有 recipient 恢复。
    if (syncedManifest && !syncedManifest.recipientIds.includes(userId)) return emptyRecipient();
    try {
      const recipient = await this.fileStore.readJsonUncached<RecipientProjection>(this.recipientPath(userId));
      if (recipient && Number.isInteger(recipient.unreadCount) && recipient.items) return recipient;
    } catch { /* 已知接收者走下方定向恢复 */ }
    const manifest = syncedManifest ?? await this.readManifest();
    if (!manifest.recipientIds.includes(userId)) return emptyRecipient();
    return this.rebuildRecipient(userId);
  }

  private async rebuildRecipient(userId: string): Promise<RecipientProjection> {
    const rows = await this.fileStore.readJsonl<NotificationRow>(this.sourcePath);
    const firstTombstones = new Map<string, string | null>();
    const recipient = emptyRecipient();
    for (const row of rows) {
      if (row.deleted === true) {
        if (!firstTombstones.has(row.id)) firstTombstones.set(row.id, row.deletedAt ?? null);
        const current = recipient.items[row.id];
        if (current) {
          recipient.items[row.id] = {
            ...current, read: true,
            readAt: current.readAt ?? firstTombstones.get(row.id) ?? null,
          };
        }
        continue;
      }
      if (row.userId !== userId) continue;
      const previous = recipient.items[row.id];
      const readAt = previous?.readAt ?? firstTombstones.get(row.id) ?? null;
      recipient.items[row.id] = { data: row, read: previous?.read ?? readAt !== null, readAt };
    }
    recipient.unreadCount = Object.values(recipient.items).filter(entry => !entry.read).length;
    await this.fileStore.writeJson(this.recipientPath(userId), recipient);
    return recipient;
  }

  /** 只读目标接收者持久化 count，不构造、筛选或排序通知列表。 */
  async readUnreadCount(userId: string): Promise<number> {
    return (await this.readRecipient(userId)).unreadCount;
  }

  private async applyRow(row: NotificationRow, recipientIds: Set<string>): Promise<void> {
    const entryPath = path.join(this.entriesDir, `${fileKey(row.id)}.json`);
    let previous: FoldedNotification | undefined;
    try {
      previous = JSON.parse(await fs.promises.readFile(entryPath, 'utf8')) as FoldedNotification;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CorruptedNotificationEntry(error instanceof Error ? error.message : String(error));
      }
    }
    const next: FoldedNotification = row.deleted === true
      ? { data: previous?.data ?? null, read: true, readAt: previous?.readAt ?? row.deletedAt ?? null }
      : { data: row, read: previous?.read ?? false, readAt: previous?.readAt ?? null };
    await this.fileStore.writeJson(entryPath, next);

    const previousUser = previous?.data?.userId;
    const nextUser = next.data?.userId;
    for (const userId of new Set([previousUser, nextUser].filter((id): id is string => !!id))) {
      const recipient = await this.readRecipient(userId);
      const applied = recipient.items[row.id];
      if (previousUser === userId) {
        delete recipient.items[row.id];
        // entry 可能已先提交；必须以 recipient 实际已应用项做幂等增减。
        if (applied && !applied.read) recipient.unreadCount = Math.max(0, recipient.unreadCount - 1);
      }
      if (nextUser === userId) {
        recipient.items[row.id] = next;
        if (!next.read) recipient.unreadCount += 1;
      }
      if (Object.keys(recipient.items).length === 0) {
        await fs.promises.unlink(this.recipientPath(userId)).catch(() => {});
        recipientIds.delete(userId);
      } else {
        await this.fileStore.writeJson(this.recipientPath(userId), recipient);
        recipientIds.add(userId);
      }
    }
  }

  private async readManifest(): Promise<NotificationManifest> {
    try {
      const raw = await this.fileStore.readJsonUncached<NotificationManifest>(this.manifestPath);
      if (raw?.version === 3 && Array.isArray(raw.recipientIds)) return raw;
    } catch { /* 损坏 manifest 从真源重建 */ }
    return { ...EMPTY_MANIFEST, recipientIds: [] };
  }

  private async reset(): Promise<NotificationManifest> {
    await fs.promises.rm(this.projectionDir, { recursive: true, force: true });
    const manifest = { ...EMPTY_MANIFEST, recipientIds: [] };
    await this.fileStore.writeJson(this.manifestPath, manifest);
    return manifest;
  }

  private recipientPath(userId: string): string {
    return path.join(this.recipientsDir, `${fileKey(userId)}.json`);
  }

  private headUsable(head: LogHead | null, current: LogHead): boolean {
    return !!head && head.dev === current.dev && head.ino === current.ino && head.offset <= current.offset;
  }

  private async readDelta(handle: fs.promises.FileHandle, from: number, to: number): Promise<NotificationRow[]> {
    if (from > 0) {
      const probe = Buffer.alloc(1);
      const { bytesRead } = await handle.read(probe, 0, 1, from - 1);
      if (bytesRead !== 1 || probe[0] !== 0x0a) throw new Error(`Notification projection offset is not a line boundary: ${this.sourcePath}`);
    }
    const length = to - from;
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled);
      if (bytesRead === 0) throw new Error(`Notification log truncated during projection: ${this.sourcePath}`);
      filled += bytesRead;
    }
    const rows: NotificationRow[] = [];
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as NotificationRow;
        if (typeof row.id === 'string' && row.id) rows.push(row);
      } catch { /* 与原 readJsonl 一致：跳过损坏行 */ }
    }
    return rows;
  }
}
