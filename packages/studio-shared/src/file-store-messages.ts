/**
 * FileStoreMessagesBase — FileStore 的频道消息子域层（从 file-store.ts 抽出，#655）
 *
 * messages.jsonl append-only 读写（编辑 = 同 id 追加新版、删除 = tombstone）、
 * 写侧压实（#319）、冷热归档/解冻（#327）、尾部倒扫与分页（#524/B4）、
 * 增量水位线读口（B5）、跨频道查询。
 * 继承 FileStoreWorkUnitBase（getIndex 供归档计龄锚点）；门面 FileStore 再继承本类。
 * readdirCached/readdir 与 channelsDir 随消息块下移（消息方法与门面残留的
 * listDirEntities/listEntries/listJsonInDir 共用），dirCache/statMtimeMs/cacheSet
 * 模块级共享件随之在本文件定义并 export（仅模块间共享，不进包 index）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { FileStoreWorkUnitBase, type FileStoreWorkUnitOptions } from './file-store-workunit';
import { readMetricsBegin, emitReadMetric } from './read-metrics';
import { foldJsonlById } from './jsonl-fold';
import { iterateJsonlLinesBackward, readJsonlTail } from './jsonl-tail';
import type {
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
  MessageCompactionOptions,
  MessageArchiveOptions,
  WorkUnitSnapshot,
} from './file-store-types';

// ─── 读穿缓存共享件（随消息子域自 file-store.ts 下移）───
//
// dirCache 是 readdirCached 的读穿缓存；statMtimeMs/cacheSet 是缓存层通用件，
// file-store.ts 的 json/jsonl/md 缓存经 import 继续共用（口径注释见 file-store.ts）。

interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
}

const dirCache = new Map<string, CacheEntry<fs.Dirent[]>>();
const MAX_CACHE_ENTRIES = 1000;

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
  if (map.size >= MAX_CACHE_ENTRIES) map.clear();
  map.set(key, entry);
}

/** 文件/目录 mtimeMs；不存在返回 null；其他错误抛出（与 readFile 错误语义一致） */
async function statMtimeMs(target: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(target);
    return st.mtimeMs;
  } catch (err: unknown) {
    if (isErrnoError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export { dirCache, cacheSet, statMtimeMs };
export type { CacheEntry };

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
function mergeActiveRows(rows: ChannelMessageRow[]): ChannelMessageData[] {
  const active: ChannelMessageData[] = [];
  for (const group of foldJsonlById(rows, row => row.deleted === true).values()) {
    if (group.voided) continue; // 墓碑行收尾：整条丢弃
    // 删除 deleted 字段以保持与 ChannelMessageData 类型一致
    const { deleted, ...rest } = group.latest;
    active.push(rest);
  }
  return active;
}

/**
 * 倒扫窗口的 createdAt 序列是否严格递减（#524 P1-1 快径判据）：
 * 严格递减 = 窗口内无旧消息更新副本且无等 ts 撞车——更新-append 的副本
 * createdAt 不变、位置在尾，会让序列出现上升沿或平台（等 ts 时副本的正确位置
 * 在首现处而非尾部，非严格判据放不过）。严格递减时文件序 = 时间序，
 * 尾部切片 = createdAt 精确后缀，翻页游标链完整。
 */
function isStrictlyDecreasingTs(messages: ChannelMessageData[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (new Date(messages[i].createdAt).getTime() >= new Date(messages[i - 1].createdAt).getTime()) return false;
  }
  return true;
}

/** FileStore 构造选项（#319：messageCompaction 供测试注入小阈值；#327：messageArchive 仿同模式） */
export interface FileStoreOptions extends FileStoreWorkUnitOptions {
  messageCompaction?: MessageCompactionOptions;
  messageArchive?: MessageArchiveOptions;
}

// ─── FileStoreMessagesBase 类 ───

export class FileStoreMessagesBase extends FileStoreWorkUnitBase {
  private readonly messageCompaction: Required<MessageCompactionOptions>;
  private readonly messageArchive: { maxAgeDays: number; now: () => Date };
  /** 压实评估计数（按 messages.jsonl 绝对路径；挂实例——同 baseDir 不同阈值配置的实例互不串扰） */
  private readonly messageAppendCounts = new Map<string, number>();

  constructor(baseDir?: string, opts?: FileStoreOptions) {
    super(baseDir, opts);
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

  /** readdir（withFileTypes）读穿缓存：目录 mtime 校验，目录内容增删触发重读 */
  protected async readdirCached(dir: string): Promise<fs.Dirent[]> {
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(dir);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      dirCache.delete(dir);
      const fallback = await fs.promises.readdir(dir, { withFileTypes: true }); // 保留 ENOENT 抛错语义
      if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: false, statMs: t1 - t0, readParseMs: t() - t1, cloneMs: 0 });
      return fallback;
    }
    const hit = dirCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) {
      if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return hit.value;
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: false, statMs: t1 - t0, readParseMs: t() - t1, cloneMs: 0 });
    cacheSet(dirCache, dir, { value: entries, mtimeMs });
    return entries;
  }

  /**
   * readdir 读穿缓存公开入口（#321）：聚合读层（library/sdd-legacy）扫外部仓目录用。
   * 目录 mtime 校验；目录不存在抛 ENOENT（与 fs.readdir 语义一致，调用方自行容错）。
   */
  public async readdir(dir: string): Promise<fs.Dirent[]> {
    return this.readdirCached(dir);
  }

  // ─── 路径生成 ───

  private messagesPath(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'messages.jsonl');
  }

  /** #327：冷文件目录（超龄消息按月归档，纯 ChannelMessageData 行，无 tombstone） */
  private archiveDir(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'archive');
  }

  private archiveMonthPath(channelId: string, month: string): string {
    return path.join(this.archiveDir(channelId), `messages-${month}.jsonl`);
  }

  protected channelsDir(): string {
    return path.join(this.baseDir, 'channels');
  }

  // ═══════════════════════
  // ChannelMessage (JSONL)
  // ═══════════════════════

  private messagesLockDir(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'messages.lock');
  }

  /**
   * 追加频道消息（#319：per-channel 文件锁 + 写侧压实检查）。
   * 上锁原因：压实会原子重写整个 messages.jsonl，无锁时与并发 append/tombstone 竞争
   * （压实读后写窗口内落入的新行被 rename 覆盖）会丢消息。
   */
  async appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    await this.withLock(this.messagesLockDir(channelId), async () => {
      await this.appendJsonl(this.messagesPath(channelId), msg);
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
    const rows = await super.readJsonl<ChannelMessageRow>(filePath);
    if (rows.length < this.messageCompaction.minLines) return;

    const winners = mergeActiveRows(rows);
    if ((rows.length - winners.length) / rows.length < this.messageCompaction.deadRatio) return;

    // 基类 writeJsonl 为原子写（tmp+rename），FileStore 覆盖版负责缓存失效
    await this.writeJsonl(filePath, winners);
  }

  /**
   * §4.2 发言层新鲜度检查：频道版本快照（messages.jsonl 最后一行的消息 id，含 tombstone 行——
   * 删除也要被感知为「房间已变」）。
   * #319：行号口径退役（压实会压缩行数，按原始行数下标的契约不再成立），一律以 id 为准。
   * 候选 2：改走尾部倒读（readJsonlTail limit=1），不再为取最后一行全量读+全量克隆；
   * 损坏行跳过（语义变化点：末行损坏时回退到上一完整行的 id，而非整体判读取失败——
   * 与 events 尾读同一容错口径，调用方按版本未变处理，安全方向）。
   * 读取失败（频道不存在等）返回空版本 —— 调用方按「无变化」处理，绝不阻断发言。
   */
  async getChannelVersion(channelId: string): Promise<{ lastMessageId: string | null }> {
    try {
      const { rows } = await readJsonlTail({ file: this.messagesPath(channelId), limit: 1 });
      return { lastMessageId: rows.length > 0 ? (rows[0].id as string) : null };
    } catch {
      return { lastMessageId: null };
    }
  }

  /**
   * §4.2: 读取锚点消息之后追加的活消息（过滤 tombstone，不含锚点本身）。
   * 锚点为 null（空频道快照）返回全部活消息。
   * 锚点 id 找不到——根因：压实可能抹除锚点行本身（tombstone 或被覆盖行），位置不可知——
   * 保守返回全部活消息：消费方（§4.2）过滤本 loop 自己的消息且拦截 ≤2 次后照发，
   * 代价是有界误报；反向漏报（丢掉真正的新消息）不允许。
   * 候选 2：改走尾部倒读早停——锚点是本 loop 最近见过的消息、稳态靠近文件尾，
   * 倒扫几行即停；锚点丢失（压实后偶发）才全扫，成本由压实周期性封顶（grilling Q3）。
   * 直读磁盘不进 jsonlCache（尾读即 FileStore seam 的增量读口，真源唯一，grilling Q4）。
   */
  async getMessagesSince(channelId: string, messageId: string | null): Promise<ChannelMessageData[]> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.messagesPath(channelId), 'r');
      const stat = await handle.stat();
      if (stat.size === 0) return [];

      const collected: ChannelMessageRow[] = []; // 收集顺序 = 新→旧
      for await (const { text } of iterateJsonlLinesBackward(handle, stat.size)) {
        let row: ChannelMessageRow;
        try {
          row = JSON.parse(text) as ChannelMessageRow;
        } catch {
          continue; // 损坏行跳过（同 events 尾读容错口径）
        }
        if (messageId && row.id === messageId) break; // 锚点本身不含
        collected.push(row);
      }
      collected.reverse(); // 恢复文件序（旧→新）
      // 窗口内按 id 归并（mergeActiveRows 唯一口径）：窗口内发了又删的消息不出现在增量里
      return mergeActiveRows(collected);
    } catch {
      return [];
    } finally {
      await handle?.close();
    }
  }

  /** 解析 JSONL，按 id 去重（最新条目生效），过滤已删除 */
  private resolveActiveMessages(channelId: string): Promise<ChannelMessageData[]> {
    return this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId)).then(mergeActiveRows);
  }

  /**
   * 尾部倒扫读口（#524 P1-1，#514 定案「指定频道 + 尾部倒扫」）：
   * 从 messages.jsonl 尾部倒读，收集 limit 条匹配的活消息即停，返回新→旧。
   * 去重/tombstone 口径复刻 mergeActiveRows——同 id 先见（最新版）为准、deleted 行
   * 作废整条并占位（更旧版本不复活）；损坏行跳过（同 events 尾读容错）。
   * **不按 createdAt 早停**：更新-append 使文件序 ≠ 时间序（#317 起更新副本 createdAt
   * 不变、位置在尾），遇超窗即停会漏（#514 决议已否决该候选）。
   * exhausted = 未凑满 limit 就扫到文件头（= 收集结果就是全量活消息）。
   * 直读磁盘不进 jsonlCache（同 getMessagesSince 的 seam 口径：尾读即增量读口，真源唯一）。
   */
  async readMessagesTail(
    channelId: string,
    opts: { limit: number; match?: (m: ChannelMessageData) => boolean },
  ): Promise<{ messages: ChannelMessageData[]; exhausted: boolean }> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.messagesPath(channelId), 'r');
      const stat = await handle.stat();
      if (stat.size === 0) return { messages: [], exhausted: true };

      const seen = new Set<string>();
      const out: ChannelMessageData[] = []; // 收集顺序 = 新→旧
      let exhausted = true;
      for await (const { text } of iterateJsonlLinesBackward(handle, stat.size)) {
        let row: ChannelMessageRow;
        try {
          row = JSON.parse(text) as ChannelMessageRow;
        } catch {
          continue; // 损坏行跳过
        }
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (row.deleted === true) continue; // 墓碑占位：整条作废，旧版不复活
        const { deleted, ...msg } = row;
        if (opts.match && !opts.match(msg)) continue;
        out.push(msg);
        if (out.length >= opts.limit) {
          exhausted = false;
          break;
        }
      }
      return { messages: out, exhausted };
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { messages: [], exhausted: true };
      throw err;
    } finally {
      await handle?.close();
    }
  }

  /**
   * B5（2026-09 channel-flow-audit-fix）：增量水位线读口——从字节偏移 fromOffset
   * 前向读到「打开句柄时」的文件尾（fstat 快照 size；读中追加的行归下一轮），
   * 返回窗口内 mergeActiveRows 归并的活消息（文件序 旧→新）与新水位。
   * 设计要点：
   * - 水位 = 字节偏移而非消息 id：更新副本/tombstone 只追加、原行字节不动；id 锚会被
   *   「锚消息自身的更新副本/墓碑」毒化（倒扫先撞副本即停 → 中段新消息永丢），回复检测
   *   路径漏人回复是回归，不可用 getMessagesSince 式 id 锚。
   * - newOffset = 窗口内首个 createdAt >= boundarySinceMs 行的起始偏移（无则 endOffset）：
   *   水位只越过「永久非候选」的行——调用方保证 boundarySinceMs 单调不减，未消费候选
   *   永远留在窗口内重复投递。boundarySinceMs = +∞ 时水位直接推进到文件尾。
   * - 失效检测（valid=false，调用方以 0 偏移全量重读重建水位）：fromOffset > 文件 size
   *   （压实原子重写缩短）；fromOffset-1 字节非 \n（重写+追加后错位）；短读/末字节非 \n。
   * - 直读磁盘不进 jsonlCache（同 getMessagesSince 的 seam 口径：增量读口，真源唯一）。
   */
  async readChannelMessagesDelta(
    channelId: string,
    fromOffset: number,
    opts: { boundarySinceMs: number },
  ): Promise<{ messages: ChannelMessageData[]; newOffset: number; endOffset: number; valid: boolean }> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.messagesPath(channelId), 'r');
      const stat = await handle.stat();
      const invalid = { messages: [] as ChannelMessageData[], newOffset: 0, endOffset: 0, valid: false };
      if (fromOffset > stat.size) return invalid; // 压实重写缩短 → 水位不可信
      if (fromOffset > 0) {
        const probe = Buffer.alloc(1);
        // 本包 @types/node 钉在 20.0.0 与 TS 5.7+ lib 的 ArrayBufferView 泛型不兼容
        // （同 jsonl-tail.ts 既有适配）——Buffer 运行时是 Uint8Array 子类，仅类型层转换
        const { bytesRead } = await handle.read(probe as Uint8Array, 0, 1, fromOffset - 1);
        if (bytesRead !== 1 || probe[0] !== 0x0a) return invalid; // 重写后错位（行边界协议破坏）
      }
      const length = stat.size - fromOffset;
      const rows: ChannelMessageRow[] = [];
      let newOffset = stat.size;
      if (length > 0) {
        const buf = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buf as Uint8Array, filled, length - filled, fromOffset + filled);
          if (bytesRead === 0) return invalid; // 截断（追加/原子重写协议外） → 全量重来
          filled += bytesRead;
        }
        if (buf[length - 1] !== 0x0a) return invalid; // 末行不完整 → 水位不可信
        let lineStart = 0;
        let boundaryFound = false;
        for (let i = 0; i < length; i++) {
          if (buf[i] !== 0x0a) continue;
          if (i > lineStart) {
            let row: ChannelMessageRow | null = null;
            try {
              row = JSON.parse(buf.toString('utf-8', lineStart, i)) as ChannelMessageRow;
            } catch {
              row = null; // 损坏行跳过（与 readJsonl 同容错口径）
            }
            if (row) {
              rows.push(row);
              // tombstone（deleted）不参与边界：它作废的目标必在其前（文件序），
              // 水位越过它对候选集无影响
              if (!boundaryFound && row.deleted !== true
                && new Date(row.createdAt).getTime() >= opts.boundarySinceMs) {
                newOffset = fromOffset + lineStart;
                boundaryFound = true;
              }
            }
          }
          lineStart = i + 1;
        }
      }
      return { messages: mergeActiveRows(rows), newOffset, endOffset: stat.size, valid: true };
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        // 频道/文件不存在 → 空窗口 + 水位归零（文件出现后从 0 全读）
        return { messages: [], newOffset: 0, endOffset: 0, valid: true };
      }
      throw err;
    } finally {
      await handle?.close();
    }
  }

  /**
   * B5：消息频道目录枚举——与 queryAllMessages 同口径（channels 目录是事实源，
   * 含无 config 的频道目录）。供 observe 增量水位线在「任一活跃 WU 无 channelId」
   * 退化全扫时枚举扫描面；目录不存在按空处理（同 queryAllMessages 容错口径）。
   */
  async listMessageChannelIds(): Promise<string[]> {
    try {
      const entries = await this.readdirCached(this.channelsDir());
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * B4（2026-09-16 channel 体检）：before 锚点热层倒扫——从 messages.jsonl 尾部倒读，
   * 命中锚点后多收 limit+1 条活跃消息即停（锚不存在则扫到文件头）。
   * 去重/tombstone/损坏行口径同 readMessagesTail（复刻 mergeActiveRows）。
   * window = 扫描见过的全部活跃消息（新→旧），anchorIdx = 锚点在 window 中的下标；
   * 锚点起的后缀（window.slice(anchorIdx)）最多 limit+1 条（锚 + limit + 1 判 hasMore）。
   * 调用方出页前须校验：① 锚点起后缀 createdAt 严格递减（判据同首页快径——窗口内
   * 文件序=时间序）；② 比锚点新（扫描序靠前）的活跃消息 createdAt 全部 > 锚点
   * （否则其按 createdAt 应排在锚点之前、属于页内，倒扫窗口不含它 → 回退全量保精确）。
   * exhausted = 扫到文件头（此时 hotIds/activeCount = 热层全量精确值，供冷侧去重与 total）；
   * 未穷举时 hotIds/activeCount 只是尾部窗口的部分值，调用方不得使用。
   * 直读磁盘不进 jsonlCache（同 readMessagesTail 的 seam 口径）。
   */
  private async scanHotToAnchor(
    channelId: string,
    anchorId: string,
    limit: number,
  ): Promise<{ found: boolean; window: ChannelMessageData[]; anchorIdx: number; hotIds: Set<string>; activeCount: number; exhausted: boolean }> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.messagesPath(channelId), 'r');
      const stat = await handle.stat();
      const hotIds = new Set<string>();
      const window: ChannelMessageData[] = [];
      let anchorIdx = -1;
      let exhausted = true;
      if (stat.size > 0) {
        const seen = new Set<string>();
        for await (const { text } of iterateJsonlLinesBackward(handle, stat.size)) {
          let row: ChannelMessageRow;
          try {
            row = JSON.parse(text) as ChannelMessageRow;
          } catch {
            continue; // 损坏行跳过（同尾读容错口径）
          }
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          if (row.deleted === true) continue; // 墓碑占位：整条作废，旧版不复活
          const { deleted, ...msg } = row;
          hotIds.add(msg.id);
          window.push(msg);
          if (msg.id === anchorId) anchorIdx = window.length - 1;
          if (anchorIdx !== -1 && window.length - anchorIdx > limit + 1) { // 锚 + limit + 1 判 hasMore
            exhausted = false;
            break;
          }
        }
      }
      return { found: anchorIdx !== -1, window, anchorIdx, hotIds, activeCount: hotIds.size, exhausted };
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        return { found: false, window: [], anchorIdx: -1, hotIds: new Set(), activeCount: 0, exhausted: true };
      }
      throw err;
    } finally {
      await handle?.close();
    }
  }

  async queryMessages(channelId: string, opts?: QueryOpts): Promise<ChannelMessageData[]> {
    // #524 P1-1 尾部快径（#514 第 4 子项）：limit 且无任何过滤 → 倒扫切片，
    // 不付全量读/clone/归并税。窗口 createdAt 序列非严格递减（混入更新副本或
    // 等 ts 撞车 = 文件序≠时间序）→ 回退全量路径保精确（单副本必被严格性检查
    // 捕获；多副本交织的病态窗口理论上有界偏差，压实 #319 自愈）。
    // B5（2026-09-16 channel 体检）：limit 且带过滤 → 同一快径加谓词（倒扫按匹配
    // 计数早停），谓词与下方全量路径四条 filter 逐句同语义；无 limit 的带过滤查询
    // 无早停收益（倒扫亦需扫到文件头），保持全量路径不动。
    // #576：before（createdAt 严格 <）与 since（>=）互补，同为谓词一员。
    if (opts?.limit !== undefined && opts.limit > 0) {
      if (!opts.workUnitId && !opts.authorType && !opts.since && !opts.before) {
        const { messages, exhausted } = await this.readMessagesTail(channelId, { limit: opts.limit });
        if (exhausted || isStrictlyDecreasingTs(messages)) {
          messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          return messages;
        }
      } else {
        const sinceMs = opts.since !== undefined ? new Date(opts.since).getTime() : null;
        const beforeMs = opts.before !== undefined ? new Date(opts.before).getTime() : null;
        const match = (m: ChannelMessageData): boolean => {
          if (opts.workUnitId && m.workUnitId !== opts.workUnitId) return false;
          if (opts.authorType && m.authorType !== opts.authorType) return false;
          // 与全量路径同口径：>= 比较（NaN 输入一律不匹配，不静默放宽）
          if (sinceMs !== null && !(new Date(m.createdAt).getTime() >= sinceMs)) return false;
          // before 同口径：严格 <（NaN 输入一律不匹配）
          if (beforeMs !== null && !(new Date(m.createdAt).getTime() < beforeMs)) return false;
          return true;
        };
        const { messages, exhausted } = await this.readMessagesTail(channelId, { limit: opts.limit, match });
        if (exhausted || isStrictlyDecreasingTs(messages)) {
          messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          return messages;
        }
      }
    }
    const resolved = await this.resolveActiveMessages(channelId);
    let filtered: ChannelMessageData[] = resolved;

    if (opts?.workUnitId) {
      filtered = filtered.filter(m => m.workUnitId === opts.workUnitId);
    }
    if (opts?.authorType) {
      filtered = filtered.filter(m => m.authorType === opts.authorType);
    }
    if (opts?.since) {
      const since = new Date(opts.since).getTime();
      filtered = filtered.filter(m => new Date(m.createdAt).getTime() >= since);
    }
    if (opts?.before) {
      const before = new Date(opts.before).getTime();
      filtered = filtered.filter(m => new Date(m.createdAt).getTime() < before);
    }

    // 按创建时间升序
    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (opts?.limit !== undefined && opts.limit > 0) {
      filtered = filtered.slice(-opts.limit);
    }

    return filtered;
  }

  /**
   * 频道消息分页（#319 半下沉 + #327 冷热穿透）：存储层过滤→排序→切片，路由不再全量拉回内存切。
   * before = 锚点消息 id 游标（不含锚点；替代原 timestamp 游标——同毫秒多条消息不再漏/重）。
   * 锚点 id 不存在（已删除/被压实抹除/冷热都没有）→ 空页 + hasMore=false：位置不可知时不整页错发。
   *
   * #327 穿透规则：遍历链 = 热（新→旧）接冷（月新→旧、月内 createdAt 新→旧）；
   * 无 before（最新页）热页不足 limit 从冷链补满（热全空时首页直接出冷，历史永远在）；
   * 锚在热而热侧不足 limit 时余量从冷续；锚在冷则整页从冷出；
   * 跨冷热按 id 去重（thaw/崩溃残留同 id，新→旧先见为准——热侧恒遮蔽冷侧残留）。
   * 无冷数据（无 archive 目录）时行为与 #319 现状逐条一致。
   *
   * 候选 8（冷链惰性分页）：冷侧不再逐月全量物化——按遍历序逐月读，
   * 页凑满 + hasMore 判定（多收 1 条）即停，后续冷月不读；hasMore 不再依赖全量计数。
   * total 统一为「热 + 冷原始行数」三分支同口径（原语义随分支漂移：无锚=全链总数、
   * 锚在冷=比锚点旧的数量；前端不消费 total）：冷行数走字节快扫数 LF，不 parse/clone/sort，
   * thaw/崩溃残留行计入会虚高（方向安全，偏多不丢）。
   * #525 P2-4：total 统计默认关闭（includeTotal 缺省 false → 完全跳过冷/热行数统计，total 恒 0），
   * 要总数的调用方显式 includeTotal: true，口径不变。
   */
  async queryMessagesPage(channelId: string, opts?: MessagePageOpts): Promise<MessagePage> {
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 50;

    if (!opts?.before) {
      // #524 P1-1 首页快径（#514 第 4 子项 / #510 嫌疑①）：尾部倒扫 limit+1 条出页，
      // 省全热文件读/clone/sort（20k 行 90ms → 亚毫秒）。语义对照原全量路径：
      // - 倒扫凑满 limit+1 ⟺ 活消息 > limit（hasMore 恒真、不补冷）；
      // - 未凑满即扫到文件头（exhausted）⟺ 活消息 ≤ limit，收集结果 = 全量活消息，
      //   补冷/去重/total 与原路径逐条一致；
      // - 窗口 createdAt 序列严格递减 = 窗口内无旧消息更新副本、无等 ts 撞车
      //   （文件序=时间序），首页 = createdAt 精确后缀，before 游标翻页链完整；
      //   非严格递减（窗口混入更新副本/等 ts）→ 回退下方全量路径保精确
      //   （单副本必被严格性检查捕获；多副本交织的病态窗口理论上有界偏差，
      //   压实 #319 清死行后自愈）。
      const tail = await this.readMessagesTail(channelId, { limit: limit + 1 });
      if (tail.exhausted || isStrictlyDecreasingTs(tail.messages)) {
        // #525 P2-4：includeTotal 未开启（缺省）时完全跳过 countColdLines/countFileLines，total 恒 0
        // total 热部：穷举 = 精确活数；未穷举 = 字节快扫原始行数（死行虚高，方向安全偏多——
        // 与冷侧「thaw/崩溃残留行计入」同口径，前端不消费 total）
        const total = opts?.includeTotal
          ? (tail.exhausted
            ? tail.messages.length
            : await this.countFileLines(this.messagesPath(channelId)))
          + await this.countColdLines(channelId)
          : 0;

        const hasHotMore = tail.messages.length > limit;
        const hotPage = tail.messages.slice(0, limit); // 新→旧（单调窗口内 = createdAt 降序）
        hotPage.reverse(); // → createdAt 升序（与原路径 sort 后切片同口径）
        const coldNeed = limit - hotPage.length;
        const coldPart: ChannelMessageData[] = [];
        if (tail.exhausted) {
          // 热不超页才需要冷：补页 + 多收 1 条判 hasMore（热已超页则 hasMore 恒 true，不读冷）
          const hotIds = new Set(tail.messages.map(m => m.id));
          for await (const msg of this.iterateColdMessages(channelId, hotIds)) {
            coldPart.push(msg);
            if (coldPart.length > coldNeed) break;
          }
        }
        return {
          messages: [...coldPart.slice(0, coldNeed).reverse(), ...hotPage],
          total,
          hasMore: hasHotMore || coldPart.length > coldNeed,
        };
      }
      // 严格性违例（窗口混入更新副本/等 ts 撞车）→ 落回下方全量路径
    }

    if (opts?.before) {
      // B4（2026-09-16 channel 体检）锚在热层倒扫快径：原路径锚在热也全量
      // resolveActiveMessages + sort + findIndex（每页 O(N)，翻 k 页 = k×O(N)）；
      // 改倒扫到锚再多收 limit+1 条即停（页成本与锚点深度成正比）。
      // 语义对照全量路径，两个出页判据（见 scanHotToAnchor 注释）：
      // - 锚点起后缀 createdAt 严格递减 = 页区内文件序=时间序（判据同首页快径），
      //   「锚点之后 limit 条（扫描序）」=「按 createdAt 紧邻锚点之前的 limit 条」；
      // - 比锚点新（扫描序靠前）的活跃消息 createdAt 全部 > 锚点——锚点/更旧消息的
      //   更新副本落在尾部（createdAt ≤ 锚点却不在页窗口内）等病态序 → 两条任一违例
      //   落回下方全量路径保精确（压实 #319 自愈，同首页快径的接受口径）；
      // - 锚点倒扫穷举未命中 = 热层无此锚 → 直走冷链锚路径（热层已全扫，
      //   hotIds/activeCount 为精确全量，免 resolveActiveMessages）；
      // - total：穷举 = 精确活跃数（同全量路径）；未穷举 = 字节快扫原始行数
      //   （死行虚高，方向安全偏多——同首页快径口径）。
      const scan = await this.scanHotToAnchor(channelId, opts.before, limit);
      if (scan.found) {
        const anchorTs = new Date(scan.window[scan.anchorIdx].createdAt).getTime();
        let preAnchorNewer = true;
        for (let i = 0; i < scan.anchorIdx; i++) {
          if (new Date(scan.window[i].createdAt).getTime() <= anchorTs) { preAnchorNewer = false; break; }
        }
        const fromAnchor = scan.window.slice(scan.anchorIdx);
        if (preAnchorNewer && isStrictlyDecreasingTs(fromAnchor)) {
          const total = opts?.includeTotal
            ? (scan.exhausted ? scan.activeCount : await this.countFileLines(this.messagesPath(channelId)))
              + await this.countColdLines(channelId)
            : 0;
          const afterAnchor = fromAnchor.slice(1); // 比锚旧的活跃消息（新→旧）
          const hotPage = afterAnchor.slice(0, limit);
          hotPage.reverse(); // → createdAt 升序（与全量路径 sort 后切片同口径）
          const coldNeed = limit - hotPage.length;
          const coldPart: ChannelMessageData[] = [];
          if (scan.exhausted) {
            // 穷举时锚前热消息必不足 limit+1（镜像全量路径 anchor <= limit 分支）：
            // 余量从冷续 + 多收 1 条判 hasMore（coldNeed=0 也要探 1 条——冷链整体更旧）
            for await (const msg of this.iterateColdMessages(channelId, scan.hotIds)) {
              coldPart.push(msg);
              if (coldPart.length > coldNeed) break;
            }
          }
          return {
            messages: [...coldPart.slice(0, coldNeed).reverse(), ...hotPage],
            total,
            hasMore: afterAnchor.length > limit || coldPart.length > coldNeed,
          };
        }
        // 判据违例 → 落回下方全量路径
      } else {
        // 锚不在热层（倒扫已穷举热文件）：锚在冷或不存在——直走冷链锚路径，
        // 多收 limit+1 条即停；扫完未命中 = 锚不存在 → 空页 + hasMore=false
        const total = opts?.includeTotal ? scan.activeCount + await this.countColdLines(channelId) : 0;
        const older: ChannelMessageData[] = [];
        let anchorFound = false;
        for await (const msg of this.iterateColdMessages(channelId, scan.hotIds)) {
          if (!anchorFound) {
            if (msg.id === opts.before) anchorFound = true;
            continue;
          }
          older.push(msg);
          if (older.length > limit) break;
        }
        if (!anchorFound) {
          return { messages: [], total, hasMore: false };
        }
        return {
          messages: older.slice(0, limit).reverse(),
          total,
          hasMore: older.length > limit,
        };
      }
    }

    const resolved = await this.resolveActiveMessages(channelId);
    // 按创建时间升序（与 queryMessages 同口径；同刻消息按文件序稳定排列）
    resolved.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const hotIds = new Set(resolved.map(m => m.id));
    // #525 P2-4：includeTotal 未开启（缺省）时完全跳过 countColdLines，total 恒 0
    const total = opts?.includeTotal
      ? resolved.length + await this.countColdLines(channelId)
      : 0;

    if (!opts?.before) {
      // 无 before 的原全量首页路径（#524 快径严格性违例时回退到此）：
      // 最新页热页不足 limit 从冷链（新→旧）补满——热全空时首页直接出冷数据
      const hotPage = resolved.slice(-limit);
      const coldNeed = limit - hotPage.length;
      const coldPart: ChannelMessageData[] = [];
      if (resolved.length <= limit) {
        // 热不超页才需要冷：补页 + 多收 1 条判 hasMore（热已超页则 hasMore 恒 true，不读冷）
        for await (const msg of this.iterateColdMessages(channelId, hotIds)) {
          coldPart.push(msg);
          if (coldPart.length > coldNeed) break;
        }
      }
      return {
        messages: [...coldPart.slice(0, coldNeed).reverse(), ...hotPage],
        total,
        hasMore: resolved.length > limit || coldPart.length > coldNeed,
      };
    }

    const anchor = resolved.findIndex(m => m.id === opts.before);
    if (anchor !== -1) {
      // 锚在热：链上锚点之前 = 热[0..anchor) 接整条冷链；页 = 该序列末尾 limit 条（升序）
      const hotPage = resolved.slice(Math.max(0, anchor - limit), anchor);
      const coldNeed = limit - hotPage.length;
      const coldPart: ChannelMessageData[] = [];
      if (anchor <= limit) {
        // anchor > limit 时锚前热消息已超 limit，hasMore 恒 true 且无需补冷
        for await (const msg of this.iterateColdMessages(channelId, hotIds)) {
          coldPart.push(msg);
          if (coldPart.length > coldNeed) break;
        }
      }
      return {
        messages: [...coldPart.slice(0, coldNeed).reverse(), ...hotPage],
        total,
        hasMore: anchor > limit || coldPart.length > coldNeed,
      };
    }

    // 锚在冷（或不存在）：惰性扫冷找到锚后多收 limit+1 条即停；
    // 扫完未命中 = 锚不存在 → 空页 + hasMore=false
    const older: ChannelMessageData[] = [];
    let anchorFound = false;
    for await (const msg of this.iterateColdMessages(channelId, hotIds)) {
      if (!anchorFound) {
        if (msg.id === opts.before) anchorFound = true;
        continue;
      }
      older.push(msg);
      if (older.length > limit) break;
    }
    if (!anchorFound) {
      return { messages: [], total, hasMore: false };
    }
    return {
      messages: older.slice(0, limit).reverse(),
      total,
      hasMore: older.length > limit,
    };
  }

  /**
   * 冷链惰性遍历（新→旧，候选 8）：逐月读（读穿缓存摊销），月内 createdAt 降序；
   * 热侧 id 遮蔽冷侧残留 + 冷内同 id 先见为准。调用方 break 即停——后面的冷月不读，
   * 分页成本与页深成正比而非与全历史成正比。
   */
  private async *iterateColdMessages(channelId: string, hotIds: Set<string>): AsyncGenerator<ChannelMessageData> {
    const seenCold = new Set<string>();
    for (const month of await this.listArchiveMonths(channelId)) {
      const rows = await this.readJsonl<ChannelMessageData>(this.archiveMonthPath(channelId, month));
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      for (const msg of rows) {
        if (hotIds.has(msg.id) || seenCold.has(msg.id)) continue;
        seenCold.add(msg.id);
        yield msg;
      }
    }
  }

  /** 冷文件原始总行数（含被热遮蔽/重复残留行）：字节快扫数 LF，不 parse/clone（候选 8 total 口径） */
  private async countColdLines(channelId: string): Promise<number> {
    let total = 0;
    for (const month of await this.listArchiveMonths(channelId)) {
      total += await this.countFileLines(this.archiveMonthPath(channelId, month));
    }
    return total;
  }

  /** 冷文件月清单（YYYY-MM，新→旧）；无 archive 目录 → [] */
  private async listArchiveMonths(channelId: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await this.readdirCached(this.archiveDir(channelId));
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter(e => e.isFile())
      .map(e => /^messages-(\d{4}-\d{2})\.jsonl$/.exec(e.name)?.[1])
      .filter((m): m is string => m !== undefined)
      .sort()
      .reverse();
  }

  /** 单文件行数（字节快扫数 LF；末字节非 LF 时 +1）：不 parse/clone，文件不存在 → 0 */
  private async countFileLines(filePath: string): Promise<number> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stat = await handle.stat();
      if (stat.size === 0) return 0;
      let lines = 0;
      let lastByte = -1;
      let pos = 0;
      const chunk = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      while (pos < stat.size) {
        const len = Math.min(chunk.length, stat.size - pos);
        // 本包 @types/node 钉版与 TS 5.7+ lib 泛型不兼容，Buffer 即 Uint8Array 子类（同 jsonl-tail）
        await handle.read(chunk as Uint8Array, 0, len, pos);
        for (let i = 0; i < len; i++) if (chunk[i] === 0x0a) lines++;
        lastByte = chunk[len - 1];
        pos += len;
      }
      return lastByte === 0x0a ? lines : lines + 1;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return 0;
      throw e;
    } finally {
      await handle?.close();
    }
  }

  async softDeleteMessage(channelId: string, messageId: string): Promise<void> {
    // #319：与 appendMessage 同锁——压实重写与 tombstone 追加竞争会丢 tombstone（已删消息复活）
    await this.withLock(this.messagesLockDir(channelId), async () => {
      // 锁内裸读（ADR 例外条款）：要删的必须是此刻磁盘最新状态，不走读穿缓存
      const all = await super.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      const msg = all.find(m => m.id === messageId && !m.deleted);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      // append tombstone
      const tombstone: ChannelMessageRow = {
        ...msg,
        deleted: true,
      };
      await this.appendJsonl(this.messagesPath(channelId), tombstone);
      await this.compactMessagesIfNeededLocked(channelId);
    });
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
    const nowMs = this.messageArchive.now().getTime();
    const maxAgeMs = this.messageArchive.maxAgeDays * 86_400_000;
    // WU 计龄锚点索引（读穿缓存 mtime 校验；sweep 是离线任务，锚点滞后最多影响一轮）
    const wuIndex = new Map((await this.getIndex()).map(s => [s.id, s]));

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.channelsDir(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { archivedMessages: 0 };
      throw err;
    }

    let archivedMessages = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      archivedMessages += await this.withLock(this.messagesLockDir(entry.name), () =>
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
    const filePath = this.messagesPath(channelId);
    // 锁内裸读（ADR 例外条款，同压实）：归档依据必须是此刻磁盘真值
    const rows = await super.readJsonl<ChannelMessageRow>(filePath);
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
      const monthPath = this.archiveMonthPath(channelId, month);
      const existingIds = new Set((await super.readJsonl<ChannelMessageData>(monthPath)).map(m => m.id));
      for (const msg of msgs) {
        if (existingIds.has(msg.id)) continue;
        await this.appendJsonl(monthPath, msg);
      }
    }
    // 后原子重写热文件（tmp+rename，同压实纪律；崩溃在中间 = 同 id 冷热都有，查询面按 id 去重）
    await this.writeJsonl(filePath, keep);
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
      entries = await fs.promises.readdir(this.channelsDir(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { thawedMessages: 0 };
      throw err;
    }
    let thawedMessages = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const months = await this.listArchiveMonths(entry.name);
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
      const rows = await this.readJsonl<ChannelMessageData>(this.archiveMonthPath(channelId, month));
      if (rows.some(m => m.workUnitId === workUnitId)) { hasMatch = true; break; }
    }
    if (!hasMatch) return 0;

    return this.withLock(this.messagesLockDir(channelId), async () => {
      // 锁内裸读重判（预检后可能有并发 sweep/thaw 改动）
      const thawRows: ChannelMessageData[] = [];
      const rewrittenMonths: Array<{ monthPath: string; remain: ChannelMessageData[] }> = [];
      for (const month of months) {
        const monthPath = this.archiveMonthPath(channelId, month);
        const rows = await super.readJsonl<ChannelMessageData>(monthPath);
        const remain = rows.filter(m => {
          if (m.workUnitId === workUnitId) { thawRows.push(m); return false; }
          return true;
        });
        if (remain.length !== rows.length) rewrittenMonths.push({ monthPath, remain });
      }
      if (thawRows.length === 0) return 0;

      // 先 append 回热文件（保留原 id/createdAt，按 createdAt 升序；热侧已有同 id 不重复）
      const hotPath = this.messagesPath(channelId);
      const hotIds = new Set((await super.readJsonl<ChannelMessageRow>(hotPath)).map(r => r.id));
      thawRows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let appended = 0;
      for (const msg of thawRows) {
        if (hotIds.has(msg.id)) continue;
        await this.appendJsonl(hotPath, msg);
        appended++;
      }
      // 后原子重写冷文件剔除已 thaw 行（tmp+rename，同 sweep 纪律）
      for (const { monthPath, remain } of rewrittenMonths) {
        await this.writeJsonl(monthPath, remain);
      }
      return appended;
    });
  }

  /**
   * 跨频道查询消息（扫描所有 channel 的 messages.jsonl）。
   * 支持按 workUnitId(s) 和 authorType 过滤。
   * #330：可选 channelIds 预过滤——提供时 readdir 后跳过集合外频道（不读其文件），
   * 供 observe 巡查只扫活跃 WU 所在频道；缺省全扫，既有调用方行为不变。
   */
  async queryAllMessages(filter?: { workUnitIds?: string[]; workUnitId?: string; authorType?: string; agentName?: string; agentNames?: string[]; channelIds?: string[] }): Promise<ChannelMessageData[]> {
    const result: ChannelMessageData[] = [];
    const dir = this.channelsDir();
    try {
      const entries = await this.readdirCached(dir);
      const channelSet = filter?.channelIds ? new Set(filter.channelIds) : null;
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return [];
        if (channelSet && !channelSet.has(entry.name)) return [];
        const active = await this.resolveActiveMessages(entry.name);
        return active.filter(msg => {
          if (filter?.workUnitId && msg.workUnitId !== filter.workUnitId) return false;
          if (filter?.workUnitIds && msg.workUnitId && !filter.workUnitIds.includes(msg.workUnitId)) return false;
          if (filter?.authorType && msg.authorType !== filter.authorType) return false;
          if (filter?.agentName && msg.agentName !== filter.agentName) return false;
          if (filter?.agentNames && msg.agentName && !filter.agentNames.includes(msg.agentName)) return false;
          return true;
        });
      }));
      for (const msgs of perChannel) result.push(...msgs);
    } catch {
      // channels dir 不存在 → 空结果
    }
    return result;
  }

  /**
   * 按全局 messageId 查找消息，返回消息及其所属 channelId。
   * #524 P1-1（#514 定案）：channelId 已知时传参走本频道倒扫直查——倒扫首见定夺
   * （首见 deleted → 已删除 null；首见普通行即最新版），O(目标位置) 而非 O(Σ全频道热文件)。
   * channelId 缺省保留全频道扇出（无频道上下文的冷路径兼容）。
   */
  async getMessageById(messageId: string, channelId?: string): Promise<{ channelId: string; message: ChannelMessageData } | null> {
    if (channelId) {
      let handle: fs.promises.FileHandle | null = null;
      try {
        handle = await fs.promises.open(this.messagesPath(channelId), 'r');
        const stat = await handle.stat();
        for await (const { text } of iterateJsonlLinesBackward(handle, stat.size)) {
          let row: ChannelMessageRow;
          try {
            row = JSON.parse(text) as ChannelMessageRow;
          } catch {
            continue; // 损坏行跳过（同尾读容错口径）
          }
          if (row.id !== messageId) continue;
          if (row.deleted === true) return null; // 墓碑首见 = 已删除
          const { deleted, ...msg } = row;
          return { channelId, message: msg };
        }
        return null;
      } catch (err: unknown) {
        if (isErrnoError(err) && err.code === 'ENOENT') return null; // 频道/文件不存在
        throw err;
      } finally {
        await handle?.close();
      }
    }
    const dir = this.channelsDir();
    try {
      const entries = await this.readdirCached(dir);
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        // #360：与 queryMessages 同走 mergeActiveRows 唯一归并口径（原为 inline 重复折叠）
        const active = mergeActiveRows(await this.readJsonl<ChannelMessageRow>(this.messagesPath(entry.name)));
        const msg = active.find(m => m.id === messageId);
        return msg ? { channelId: entry.name, message: msg } : null;
      }));
      // 保持原串行语义：按 readdir 顺序返回首个命中
      return perChannel.find(r => r !== null) ?? null;
    } catch {
      // channels dir 不存在 → 无消息
    }
    return null;
  }
}
