/**
 * PERF-05 overview 按日窗口投影。
 * WU events 与频道 messages 均为真源；这里只保存可重建的窗口数据和完整提交 offset。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChannelMessageData, FileStore, WorkUnitEvent } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;
const TAIL_CHUNK = 64 * 1024;

interface LogHead { dev: number; ino: number; offset: number }
interface HumanRow { createdAt: string; channelId: string }
interface OverviewProjectionFile {
  version: 3;
  lastPruneDay: string | null;
  wu: { head: LogHead | null; byDay: Record<string, WorkUnitEvent[]> };
  human: {
    initialized: boolean;
    channels: Record<string, LogHead>;
    idsByChannel: Record<string, string[]>;
    byDay: Record<string, Record<string, HumanRow>>;
  };
}

const emptyProjection = (): OverviewProjectionFile => ({
  version: 3,
  lastPruneDay: null,
  wu: { head: null, byDay: {} },
  human: { initialized: false, channels: {}, idsByChannel: {}, byDay: {} },
});

const dayOf = (timestamp: string): string => new Date(timestamp).toISOString().slice(0, 10);

/** 只返回末尾换行后的已提交 offset；未提交半行留待下次 append 后恢复。 */
async function committedOffset(handle: fs.promises.FileHandle, size: number): Promise<number> {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) throw new Error('Log truncated while locating committed offset');
    const newline = buffer.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

export class OverviewProjection {
  readonly lockPath: string;
  private readonly projectionPath: string;

  constructor(private readonly fileStore: FileStore, private readonly wuEventsFile: string) {
    this.lockPath = `${wuEventsFile}.overview.lock`;
    const key = createHash('sha256').update(wuEventsFile).digest('hex').slice(0, 24);
    this.projectionPath = studioPath('logs', 'projections', `overview-${key}.json`);
  }

  async load(now: number): Promise<{ wuEvents: WorkUnitEvent[]; humanMessages: Array<{ createdAt: string }> }> {
    return this.fileStore.withLock(this.lockPath, async () => {
      let projection = await this.readProjection();
      projection = await this.syncWu(projection);
      projection = await this.syncHuman(projection);
      const pruneDay = new Date(now).toISOString().slice(0, 10);
      if (projection.lastPruneDay !== pruneDay) this.prune(projection, now);
      await this.fileStore.writeJson(this.projectionPath, projection);
      return {
        wuEvents: Object.values(projection.wu.byDay).flat(),
        humanMessages: Object.values(projection.human.byDay).flatMap(rows => Object.values(rows)),
      };
    });
  }

  private async readProjection(): Promise<OverviewProjectionFile> {
    try {
      const raw = await this.fileStore.readJsonUncached<OverviewProjectionFile>(this.projectionPath);
      if (raw?.version === 3 && raw.lastPruneDay !== undefined && raw.wu?.byDay && raw.human?.byDay && raw.human.channels && raw.human.idsByChannel) return raw;
    } catch { /* 损坏派生物从真源重建 */ }
    return emptyProjection();
  }

  private async syncWu(projection: OverviewProjectionFile): Promise<OverviewProjectionFile> {
    const handle = await fs.promises.open(this.wuEventsFile, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) {
      projection.wu = { head: null, byDay: {} };
      return projection;
    }
    try {
      const stat = await handle.stat();
      if (stat.size === 0) {
        projection.wu = { head: null, byDay: {} };
        return projection;
      }
      const current = { dev: stat.dev, ino: stat.ino, offset: await committedOffset(handle, stat.size) };
      const previous = projection.wu.head;
      if (previous && (previous.dev !== current.dev || previous.ino !== current.ino || previous.offset > current.offset)) {
        projection.wu = { head: null, byDay: {} };
      } else if (previous?.offset === current.offset) {
        return projection;
      }
      const rows = await this.readWuDelta(handle, projection.wu.head?.offset ?? 0, current.offset);
      for (const row of rows) (projection.wu.byDay[dayOf(row.timestamp)] ??= []).push(row);
      projection.wu.head = current;
      return projection;
    } finally {
      await handle.close();
    }
  }

  private async syncHuman(projection: OverviewProjectionFile): Promise<OverviewProjectionFile> {
    // 轻量测试 stub 没有频道增量端口时，只在首次建立投影；生产 FileStore 走下方增量协议。
    if (typeof this.fileStore.listMessageChannelIds !== 'function' || typeof this.fileStore.readChannelMessagesDelta !== 'function') {
      if (projection.human.initialized) return projection;
      const rows = await this.fileStore.queryAllMessages({ authorType: 'human' }).catch(() => [] as ChannelMessageData[]);
      for (const row of rows) this.applyHuman(projection, row, row.channelId);
      projection.human.initialized = true;
      return projection;
    }

    const channelIds = await this.fileStore.listMessageChannelIds();
    const channelSet = new Set(channelIds);
    for (const channelId of Object.keys(projection.human.idsByChannel)) {
      if (!channelSet.has(channelId)) this.removeChannel(projection, channelId);
    }
    for (const channelId of channelIds) {
      const messagesFile = path.join(this.fileStore.getDataDir(), 'channels', channelId, 'messages.jsonl');
      const stat = await fs.promises.stat(messagesFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const previous = projection.human.channels[channelId];
      const sameGeneration = !!stat && !!previous && previous.dev === stat.dev && previous.ino === stat.ino && previous.offset <= stat.size;
      if (!sameGeneration) this.removeChannel(projection, channelId);
      let from = sameGeneration ? previous.offset : 0;
      let delta = await this.fileStore.readChannelMessagesDelta(channelId, from, { boundarySinceMs: Number.POSITIVE_INFINITY });
      const knownHumanIds = new Set(projection.human.idsByChannel[channelId] ?? []);
      const changedExisting = (delta.touchedIds ?? delta.messages.map(row => row.id)).some(id => knownHumanIds.has(id));
      if (!delta.valid || changedExisting || (delta.endOffset > from && delta.messages.length === 0)) {
        this.removeChannel(projection, channelId);
        knownHumanIds.clear();
        from = 0;
        delta = await this.fileStore.readChannelMessagesDelta(channelId, 0, { boundarySinceMs: Number.POSITIVE_INFINITY });
        if (!delta.valid) throw new Error(`Unable to rebuild human-message projection for channel ${channelId}`);
      }
      for (const row of delta.messages) {
        if (row.authorType === 'human' && !knownHumanIds.has(row.id)) this.applyHuman(projection, row, channelId);
      }
      projection.human.channels[channelId] = { dev: stat?.dev ?? 0, ino: stat?.ino ?? 0, offset: delta.endOffset };
    }
    projection.human.initialized = true;
    return projection;
  }

  private applyHuman(projection: OverviewProjectionFile, row: { id: string; createdAt: string; authorType?: string }, channelId: string): void {
    if (row.authorType !== undefined && row.authorType !== 'human') return;
    const day = dayOf(row.createdAt);
    (projection.human.byDay[day] ??= {})[row.id] = { createdAt: row.createdAt, channelId };
    const ids = projection.human.idsByChannel[channelId] ??= [];
    if (!ids.includes(row.id)) ids.push(row.id);
  }

  private removeChannel(projection: OverviewProjectionFile, channelId: string): void {
    for (const rows of Object.values(projection.human.byDay)) {
      for (const [id, row] of Object.entries(rows)) if (row.channelId === channelId) delete rows[id];
    }
    projection.human.idsByChannel[channelId] = [];
  }

  private prune(projection: OverviewProjectionFile, now: number): void {
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    for (const [day, rows] of Object.entries(projection.wu.byDay)) {
      projection.wu.byDay[day] = rows.filter(row => new Date(row.timestamp).getTime() >= cutoff);
      if (projection.wu.byDay[day].length === 0) delete projection.wu.byDay[day];
    }
    for (const [day, rows] of Object.entries(projection.human.byDay)) {
      for (const [id, row] of Object.entries(rows)) {
        if (new Date(row.createdAt).getTime() < cutoff) delete rows[id];
      }
      if (Object.keys(rows).length === 0) delete projection.human.byDay[day];
    }
    for (const channelId of Object.keys(projection.human.idsByChannel)) {
      projection.human.idsByChannel[channelId] = Object.values(projection.human.byDay)
        .flatMap(rows => Object.entries(rows))
        .filter(([, row]) => row.channelId === channelId)
        .map(([id]) => id);
    }
    projection.lastPruneDay = new Date(now).toISOString().slice(0, 10);
  }

  private async readWuDelta(handle: fs.promises.FileHandle, from: number, to: number): Promise<WorkUnitEvent[]> {
    if (from > 0) {
      const probe = Buffer.alloc(1);
      const { bytesRead } = await handle.read(probe, 0, 1, from - 1);
      if (bytesRead !== 1 || probe[0] !== 0x0a) throw new Error(`WU projection offset is not a line boundary: ${this.wuEventsFile}`);
    }
    const length = to - from;
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled);
      if (bytesRead === 0) throw new Error(`WU event log truncated during projection: ${this.wuEventsFile}`);
      filled += bytesRead;
    }
    const rows: WorkUnitEvent[] = [];
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as WorkUnitEvent;
        if (typeof row.timestamp === 'string' && Number.isFinite(new Date(row.timestamp).getTime())) rows.push(row);
      } catch { /* 与原 readJsonl 一致：跳过损坏行 */ }
    }
    return rows;
  }
}
