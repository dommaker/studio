/**
 * MessagesArchiveStore — 频道消息子域归档件（#681 P1-1 组合化：自
 * FileStoreMessagesArchiveBase 继承层转型为构造注入的独立 store；
 * #670 自 file-store-messages.ts 拆出，PURE_MOVE）
 *
 * 承载：冷热归档 sweep（#327）与 reopen 解冻。写路径/压实在
 * file-store-messages-core.ts（MessagesCoreStore），查询面在
 * file-store-messages-query.ts（MessagesQueryStore）。
 * 组合依赖：core（路径件/锁目录/计龄配置）、query（冷月清单）、
 * workunit（getIndex 供归档计龄锚点）——均为显式构造注入，替代原跨层 this 调用。
 */

import fs from 'node:fs';
import { isErrnoError } from './file-store-base';
import type { FileStoreCore } from './file-store-core';
import { type MessagesCoreStore, mergeActiveRows } from './file-store-messages-core';
import type { MessagesQueryStore } from './file-store-messages-query';
import type { WorkUnitStore } from './file-store-workunit';
import type {
  ChannelMessageData,
  ChannelMessageRow,
  WorkUnitSnapshot,
} from './file-store-types';

// ─── MessagesArchiveStore 类 ───

export class MessagesArchiveStore {
  private readonly ctx: FileStoreCore;
  private readonly core: MessagesCoreStore;
  private readonly query: MessagesQueryStore;
  private readonly workunit: WorkUnitStore;

  constructor(ctx: FileStoreCore, core: MessagesCoreStore, query: MessagesQueryStore, workunit: WorkUnitStore) {
    this.ctx = ctx;
    this.core = core;
    this.query = query;
    this.workunit = workunit;
  }

  // ─── 消息生命周期归档（#327）───

  /**
   * 归档 sweep：逐频道把超龄活消息从热文件搬入冷文件（archive/messages-YYYY-MM.jsonl）。
   * 定期任务（启动一次 + 每 24h，挂 index.ts 轮转调度点），非请求路径。
   *
   * 超龄规则：有 workUnitId → 所属 WU 的 closedAt + maxAgeDays（closedAt 缺失的遗产数据
   * 回退 updatedAt；WU 悬空回退消息 createdAt 规则；WU 非 closed 一律保留）；
   * 无 workUnitId → 消息 createdAt + maxAgeDays。
   *
   * 纪律：per-channel messages.lock 锁内操作（与并发 append/tombstone/压实互斥）；
   * 写序先冷后热——崩溃在中间 = 同 id 冷热都有，下次 sweep 冷侧按 id 去重吸收；
   * 无超龄消息不动热文件（不重写、不 bump mtime）；归并走 mergeActiveRows 唯一口径
   * （顺带压实效果：死行不进冷热文件）。
   */
  async archiveChannelMessages(): Promise<{ archivedMessages: number }> {
    const nowMs = this.core.messageArchive.now().getTime();
    const maxAgeMs = this.core.messageArchive.maxAgeDays * 86_400_000;
    // WU 计龄锚点索引（读穿缓存 mtime 校验；sweep 是离线任务，锚点滞后最多影响一轮）
    const wuIndex = new Map((await this.workunit.getIndex()).map(s => [s.id, s]));

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.core.channelsDir(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { archivedMessages: 0 };
      throw err;
    }

    let archivedMessages = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      archivedMessages += await this.ctx.base.withLock(this.core.messagesLockDir(entry.name), () =>
        this.archiveChannelMessagesLocked(entry.name, wuIndex, nowMs, maxAgeMs));
    }
    return { archivedMessages };
  }

  /** 单频道归档（锁内专用：withLock 不可重入，调用方须已持 messages.lock） */
  private async archiveChannelMessagesLocked(
    channelId: string,
    wuIndex: Map<string, WorkUnitSnapshot>,
    nowMs: number,
    maxAgeMs: number,
  ): Promise<number> {
    const filePath = this.core.messagesPath(channelId);
    // 锁内裸读（ADR 例外条款，同压实）：归档依据必须是此刻磁盘真值
    const rows = await this.ctx.base.readJsonl<ChannelMessageRow>(filePath);
    if (rows.length === 0) return 0;

    const active = mergeActiveRows(rows);
    const keep: ChannelMessageData[] = [];
    const archive: ChannelMessageData[] = [];
    for (const msg of active) {
      const anchorMs = this.archiveAnchorMs(msg, wuIndex);
      if (anchorMs !== null && nowMs - anchorMs >= maxAgeMs) archive.push(msg);
      else keep.push(msg);
    }
    if (archive.length === 0) return 0; // 空操作纪律：无超龄不动热文件

    // 先追加冷文件（按消息 createdAt 归月、月内升序；追加前按 id 去重——吸收崩溃残留/重复 sweep）
    const byMonth = new Map<string, ChannelMessageData[]>();
    for (const msg of archive) {
      const month = msg.createdAt.slice(0, 7); // ISO 8601 前缀 YYYY-MM
      const list = byMonth.get(month);
      if (list) list.push(msg);
      else byMonth.set(month, [msg]);
    }
    for (const [month, msgs] of byMonth) {
      msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const monthPath = this.core.archiveMonthPath(channelId, month);
      const existingIds = new Set((await this.ctx.base.readJsonl<ChannelMessageData>(monthPath)).map(m => m.id));
      for (const msg of msgs) {
        if (existingIds.has(msg.id)) continue;
        await this.ctx.io.appendJsonl(monthPath, msg);
      }
    }
    // 后原子重写热文件（tmp+rename，同压实纪律；崩溃在中间 = 同 id 冷热都有，查询面按 id 去重）
    await this.ctx.io.writeJsonl(filePath, keep);
    return archive.length;
  }

  /**
   * 单条消息的计龄锚点（epoch ms）；返回 null = 一律保留（活 WU / 锚点日期损坏）。
   * 损坏锚点按保留处理：宁可多留一轮不丢可读性。
   */
  private archiveAnchorMs(msg: ChannelMessageData, wuIndex: Map<string, WorkUnitSnapshot>): number | null {
    let anchorIso: string;
    if (msg.workUnitId) {
      const wu = wuIndex.get(msg.workUnitId);
      if (wu && wu.status !== 'closed') return null; // 活 WU 的消息永远在热层
      // 遗产 closedAt 缺失回退 updatedAt；WU 悬空（已删除/从未存在）回退 createdAt 规则
      anchorIso = wu ? (wu.closedAt ?? wu.updatedAt) : msg.createdAt;
    } else {
      anchorIso = msg.createdAt;
    }
    const t = Date.parse(anchorIso);
    return Number.isNaN(t) ? null : t;
  }

  /**
   * reopen 解冻（#327）：把该 WU 的已归档消息从冷文件搬回热文件（保留原 id/createdAt），
   * 冷文件原子重写剔除已 thaw 行。规则保持一条线：活 WU 的消息永远在热层。
   * 低频操作（WU closed→unassigned 钩子），全频道扫描成本可接受；
   * 无 archive 目录/无匹配行 = 零成本短路（不取锁、不动热文件）。
   * 写序先热后冷：崩溃在中间 = 同 id 冷热都有，查询面按 id 去重（热侧遮蔽冷侧残留）。
   */
  async thawWorkUnitMessages(workUnitId: string): Promise<{ thawedMessages: number }> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.core.channelsDir(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { thawedMessages: 0 };
      throw err;
    }
    let thawedMessages = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const months = await this.query.listArchiveMonths(entry.name);
      if (months.length === 0) continue; // 零成本短路：无冷文件不取锁
      thawedMessages += await this.thawChannelWorkUnitMessages(entry.name, workUnitId, months);
    }
    return { thawedMessages };
  }

  /** 单频道解冻：锁外预检无匹配不取锁；锁内裸读重判后先 append 热、后原子重写冷 */
  private async thawChannelWorkUnitMessages(channelId: string, workUnitId: string, months: string[]): Promise<number> {
    // 锁外预检（读穿缓存）：该频道冷文件无此 WU 的行 → 不取锁
    let hasMatch = false;
    for (const month of months) {
      const rows = await this.ctx.io.readJsonl<ChannelMessageData>(this.core.archiveMonthPath(channelId, month));
      if (rows.some(m => m.workUnitId === workUnitId)) { hasMatch = true; break; }
    }
    if (!hasMatch) return 0;

    return this.ctx.base.withLock(this.core.messagesLockDir(channelId), async () => {
      // 锁内裸读重判（预检后可能有并发 sweep/thaw 改动）
      const thawRows: ChannelMessageData[] = [];
      const rewrittenMonths: Array<{ monthPath: string; remain: ChannelMessageData[] }> = [];
      for (const month of months) {
        const monthPath = this.core.archiveMonthPath(channelId, month);
        const rows = await this.ctx.base.readJsonl<ChannelMessageData>(monthPath);
        const remain = rows.filter(m => {
          if (m.workUnitId === workUnitId) { thawRows.push(m); return false; }
          return true;
        });
        if (remain.length !== rows.length) rewrittenMonths.push({ monthPath, remain });
      }
      if (thawRows.length === 0) return 0;

      // 先 append 回热文件（保留原 id/createdAt，按 createdAt 升序；热侧已有同 id 不重复）
      const hotPath = this.core.messagesPath(channelId);
      const hotIds = new Set((await this.ctx.base.readJsonl<ChannelMessageRow>(hotPath)).map(r => r.id));
      thawRows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let appended = 0;
      for (const msg of thawRows) {
        if (hotIds.has(msg.id)) continue;
        await this.ctx.io.appendJsonl(hotPath, msg);
        appended++;
      }
      // 后原子重写冷文件剔除已 thaw 行（tmp+rename，同 sweep 纪律）
      for (const { monthPath, remain } of rewrittenMonths) {
        await this.ctx.io.writeJsonl(monthPath, remain);
      }
      return appended;
    });
  }
}
