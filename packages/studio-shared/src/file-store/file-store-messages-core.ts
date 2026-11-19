/**
 * MessagesCoreStore — 频道消息子域核心件（#681 P1-1 组合化：自 FileStoreMessagesCoreBase
 * 继承层转型为构造注入 FileStoreCore 的独立 store；#670 自 file-store-messages.ts 拆出，PURE_MOVE）
 *
 * 承载：FileStoreOptions、写侧压实（#319）常量与注入、append/tombstone 写路径、消息路径件、
 * resolveActiveMessages 归并入口。查询面在 file-store-messages-query.ts（MessagesQueryStore），
 * 归档/解冻在 file-store-messages-archive.ts（MessagesArchiveStore）。
 * readdirCached/readdir 目录读穿缓存已随组合化迁入 CachedFileIo（file-store-cached.ts）——
 * 它本是通用件（entities/seq/docs/messages 四域共用），不再是消息域私有。
 * 组合壳 MessagesStore 在 file-store-messages.ts 持有本类与 query/archive 实例并委托。
 */

import path from 'node:path';
import type { FileStoreCore } from './file-store-core';
import type { FileStoreWorkUnitOptions } from './file-store-workunit';
import { foldJsonlById } from '../jsonl-fold';
import type {
  ChannelMessageData,
  ChannelMessageRow,
  MessageCompactionOptions,
  MessageArchiveOptions,
} from './file-store-types';

// ─── 频道消息写侧压实（#319）───
//
// messages.jsonl append-only：编辑 = 同 id 追加新版，删除 = 追加 tombstone 行，文件只涨不缩。
// 写侧阈值压实：append/tombstone 每满 checkInterval 次评估一次；总行数 ≥ minLines 且死行
// （被覆盖的旧版行 + 已删除消息的原行与 tombstone 行）占比 ≥ deadRatio 时，在 per-channel
// 文件锁内把活消息（每 id 最新版、首现位置序，口径同 resolveActiveMessages）原子重写回文件。
// 压实只清死行，不动任何活消息；读穿缓存靠 mtime 校验自然失效。
// 摊销设计：逐次 append 全量解析会把读穿缓存省下的成本吃回写路径，故按计数摊销；
// 计数是进程内存，重启清零最多延迟一轮评估，阈值检查自愈，无需持久化。
const MESSAGE_COMPACT_CHECK_INTERVAL = 500;
const MESSAGE_COMPACT_MIN_LINES = 5000;
const MESSAGE_COMPACT_DEAD_RATIO = 0.3;

/**
 * 频道消息生命周期归档（#327）：活消息超龄即从热文件（messages.jsonl）搬入冷文件
 * （archive/messages-YYYY-MM.jsonl，按消息 createdAt 归月），热文件体积与「在跑的活」
 * 挂钩而非频道年龄。计龄锚点：有 workUnitId → 所属 WU 的 closedAt；无 → 消息 createdAt。
 * 与 #319 压实共用 per-channel messages.lock + 原子重写 + mergeActiveRows 归并口径。
 */
const MESSAGE_ARCHIVE_MAX_AGE_DAYS = 30;

/**
 * JSONL 行归并（#319 收敛的唯一口径）：每 id 留最后出现的内容、挂首现位置、
 * deleted 整条丢弃。resolveActiveMessages / 压实 / getMessagesSince 三处共用——
 * 口径要改只改这里。
 * #360：分组折叠走共享 foldJsonlById（作废判据 = deleted 标记行，墓碑收尾即
 * voided），本函数只保留 channels 特有的「剥 deleted 字段」投影。
 */
export function mergeActiveRows(rows: ChannelMessageRow[]): ChannelMessageData[] {
  const active: ChannelMessageData[] = [];
  for (const group of foldJsonlById(rows, row => row.deleted === true).values()) {
    if (group.voided) continue; // 墓碑行收尾：整条丢弃
    // 删除 deleted 字段以保持与 ChannelMessageData 类型一致
    const { deleted, ...rest } = group.latest;
    active.push(rest);
  }
  return active;
}

/** FileStore 构造选项（#319：messageCompaction 供测试注入小阈值；#327：messageArchive 仿同模式） */
export interface FileStoreOptions extends FileStoreWorkUnitOptions {
  messageCompaction?: MessageCompactionOptions;
  messageArchive?: MessageArchiveOptions;
}

// ─── MessagesCoreStore 类 ───

export class MessagesCoreStore {
  private readonly ctx: FileStoreCore;
  private readonly messageCompaction: Required<MessageCompactionOptions>;
  /** 归档计龄配置（#327；public readonly 供 MessagesArchiveStore 消费） */
  public readonly messageArchive: { maxAgeDays: number; now: () => Date };
  /** 压实评估计数（按 messages.jsonl 绝对路径；挂实例——同 baseDir 不同阈值配置的实例互不串扰） */
  private readonly messageAppendCounts = new Map<string, number>();

  constructor(ctx: FileStoreCore, opts?: FileStoreOptions) {
    this.ctx = ctx;
    this.messageCompaction = {
      checkInterval: opts?.messageCompaction?.checkInterval ?? MESSAGE_COMPACT_CHECK_INTERVAL,
      minLines: opts?.messageCompaction?.minLines ?? MESSAGE_COMPACT_MIN_LINES,
      deadRatio: opts?.messageCompaction?.deadRatio ?? MESSAGE_COMPACT_DEAD_RATIO,
    };
    this.messageArchive = {
      maxAgeDays: opts?.messageArchive?.maxAgeDays ?? MESSAGE_ARCHIVE_MAX_AGE_DAYS,
      now: opts?.messageArchive?.now ?? (() => new Date()),
    };
  }

  // ─── 路径生成（包内公开：query/archive/entities 域经组合引用共用） ───

  public messagesPath(channelId: string): string {
    return path.join(this.ctx.baseDir, 'channels', channelId, 'messages.jsonl');
  }

  /** #327：冷文件目录（超龄消息按月归档，纯 ChannelMessageData 行，无 tombstone） */
  public archiveDir(channelId: string): string {
    return path.join(this.ctx.baseDir, 'channels', channelId, 'archive');
  }

  public archiveMonthPath(channelId: string, month: string): string {
    return path.join(this.archiveDir(channelId), `messages-${month}.jsonl`);
  }

  public channelsDir(): string {
    return path.join(this.ctx.baseDir, 'channels');
  }

  public messagesLockDir(channelId: string): string {
    return path.join(this.ctx.baseDir, 'channels', channelId, 'messages.lock');
  }

  // ═══════════════════════
  // ChannelMessage (JSONL)
  // ═══════════════════════

  /**
   * 追加频道消息（#319：per-channel 文件锁 + 写侧压实检查）。
   * 上锁原因：压实会原子重写整个 messages.jsonl，无锁时与并发 append/tombstone 竞争
   * （压实读后写窗口内落入的新行被 rename 覆盖）会丢消息。
   */
  async appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    await this.ctx.base.withLock(this.messagesLockDir(channelId), async () => {
      await this.ctx.io.appendJsonl(this.messagesPath(channelId), msg);
      await this.compactMessagesIfNeededLocked(channelId);
    });
  }

  /**
   * 压实评估（锁内专用：withLock 不可重入，严禁改走公共 appendMessage）。
   * 归并走 mergeActiveRows 唯一口径——压实前后 queryMessages 结果逐条一致。
   */
  private async compactMessagesIfNeededLocked(channelId: string): Promise<void> {
    const filePath = this.messagesPath(channelId);
    const n = (this.messageAppendCounts.get(filePath) ?? 0) + 1;
    this.messageAppendCounts.set(filePath, n);
    if (n % this.messageCompaction.checkInterval !== 0) return;

    // 锁内裸读（ADR 2026-08-24-cache-seam-decision-rules 例外条款）：压实依据必须是此刻磁盘真值
    const rows = await this.ctx.base.readJsonl<ChannelMessageRow>(filePath);
    if (rows.length < this.messageCompaction.minLines) return;

    const winners = mergeActiveRows(rows);
    if ((rows.length - winners.length) / rows.length < this.messageCompaction.deadRatio) return;

    // 原子写（tmp+rename，委托 base）+ 写后缓存失效
    await this.ctx.io.writeJsonl(filePath, winners);
  }

  /** 解析 JSONL，按 id 去重（最新条目生效），过滤已删除（读穿缓存路径） */
  public resolveActiveMessages(channelId: string): Promise<ChannelMessageData[]> {
    return this.ctx.io.readJsonl<ChannelMessageRow>(this.messagesPath(channelId)).then(mergeActiveRows);
  }

  async softDeleteMessage(channelId: string, messageId: string): Promise<void> {
    // #319：与 appendMessage 同锁——压实重写与 tombstone 追加竞争会丢 tombstone（已删消息复活）
    await this.ctx.base.withLock(this.messagesLockDir(channelId), async () => {
      // 锁内裸读（ADR 例外条款）：要删的必须是此刻磁盘最新状态，不走读穿缓存
      const all = await this.ctx.base.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      const msg = all.find(m => m.id === messageId && !m.deleted);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      // append tombstone
      const tombstone: ChannelMessageRow = {
        ...msg,
        deleted: true,
      };
      await this.ctx.io.appendJsonl(this.messagesPath(channelId), tombstone);
      await this.compactMessagesIfNeededLocked(channelId);
    });
  }
}
