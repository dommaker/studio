/**
 * MessagesQueryStore — 频道消息子域查询件（#681 P1-1 组合化：自 FileStoreMessagesQueryBase
 * 继承层转型为构造注入 FileStoreCore + MessagesCoreStore 的独立 store；
 * #670 自 file-store-messages.ts 拆出，PURE_MOVE）
 *
 * 承载：尾部倒扫与分页（#524/B4）、增量水位线读口（B5）、跨频道查询、
 * 冷链惰性遍历与计数。写路径/压实在 file-store-messages-core.ts（MessagesCoreStore），
 * 归档/解冻在 file-store-messages-archive.ts（MessagesArchiveStore）。
 *
 * #681 分页五镜像收敛：queryMessagesPage 原「热快径锚 / 冷链锚 / 全量无锚 /
 * 全量热锚 / 全量冷锚」五份切片/补冷/hasMore 镜像，收敛为单迭代器
 * iteratePageCandidates（热新→旧接冷、锚点跳过）+ assembleMessagePage
 * （收集 limit+1 即停、一次切片出页）；各分支只负责产出热侧候选流与 total。
 * queryMessages 快径谓词与全量 filter 合一为 buildQueryFilter 唯一实现。
 */

import fs from 'node:fs';
import { isErrnoError } from './file-store-base';
import type { FileStoreCore } from './file-store-core';
import { type MessagesCoreStore, mergeActiveRows } from './file-store-messages-core';
import { iterateJsonlLinesBackward, readJsonlTail } from '../jsonl-tail';
import type {
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
} from './file-store-types';

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

/**
 * queryMessages 谓词唯一实现（#681 收敛：快径 match 与全量路径 filter 原为逐句
 * 镜像的两份，现合一）。workUnitId/authorType 等值匹配；since = createdAt >=（含
 * 边界），before = createdAt 严格 <（#576 互补对）；NaN 输入一律不匹配（不静默
 * 放宽）。无任何过滤条件返回 undefined（调用方走无过滤快径/全量不 filter）。
 * 字段真值判断（`opts.since ? ... : null`）与原两路径的 truthy 语义逐句一致
 * （空串按未提供处理）。
 */
function buildQueryFilter(opts?: QueryOpts): ((m: ChannelMessageData) => boolean) | undefined {
  if (!opts) return undefined;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
  const beforeMs = opts.before ? new Date(opts.before).getTime() : null;
  if (!opts.workUnitId && !opts.authorType && sinceMs === null && beforeMs === null) return undefined;
  return (m: ChannelMessageData): boolean => {
    if (opts.workUnitId && m.workUnitId !== opts.workUnitId) return false;
    if (opts.authorType && m.authorType !== opts.authorType) return false;
    // >= 比较（NaN 输入一律不匹配，不静默放宽）
    if (sinceMs !== null && !(new Date(m.createdAt).getTime() >= sinceMs)) return false;
    // before 同口径：严格 <（NaN 输入一律不匹配）
    if (beforeMs !== null && !(new Date(m.createdAt).getTime() < beforeMs)) return false;
    return true;
  };
}

/** 锚点命中状态（iteratePageCandidates 就地置位；assembleMessagePage 据此判空页） */
export interface PageAnchorState {
  found: boolean;
}

/**
 * 分页统一迭代器（#681 五镜像收敛的单迭代器）：沿遍历链产出「页候选」——
 * 热侧候选（新→旧）接冷链惰性流（月新→旧、月内 createdAt 新→旧，跨冷热同 id
 * 先见为准、热遮蔽冷由冷流内部的 hotIds 判据保证）。
 * anchorId 给定时跳过锚点及比它新的全部候选（不含锚点本身）；命中时置
 * anchorState.found = true；锚点不存在则逐项耗尽、found 保持 false。
 * 调用方（assembleMessagePage）收集 limit+1 即 break——异步生成器惰性：
 * 热侧未穷举时冷流永不启动（后续冷月不读，分页成本与页深成正比）。
 */
export async function* iteratePageCandidates(
  hotNewToOld: Iterable<ChannelMessageData>,
  cold: AsyncIterable<ChannelMessageData>,
  anchorId: string | undefined,
  anchorState: PageAnchorState,
): AsyncGenerator<ChannelMessageData> {
  let anchorPending = anchorId !== undefined;
  for (const msg of hotNewToOld) {
    if (anchorPending) {
      if (msg.id === anchorId) { anchorPending = false; anchorState.found = true; }
      continue;
    }
    yield msg;
  }
  for await (const msg of cold) {
    if (anchorPending) {
      if (msg.id === anchorId) { anchorPending = false; anchorState.found = true; }
      continue;
    }
    yield msg;
  }
}

/**
 * 分页装配唯一出口（#681 五镜像收敛的一次切片）：从候选流收集 limit+1 条即停
 * （多收 1 条判 hasMore），一次切片出页——收集序新→旧，reverse 为 createdAt
 * 升序（与原五分支「coldPart.reverse() 接 hotPage」逐条一致：切片跨冷热边界时
 * 冷段自然落在页首）。锚点流（anchorState 传入）未命中锚点 → 空页 +
 * hasMore=false（位置不可知时不整页错发，#319 契约），total 照常返回。
 */
export async function assembleMessagePage(
  stream: AsyncIterable<ChannelMessageData>,
  limit: number,
  total: number,
  anchorState?: PageAnchorState,
): Promise<MessagePage> {
  const collected: ChannelMessageData[] = [];
  for await (const msg of stream) {
    collected.push(msg);
    if (collected.length > limit) break;
  }
  if (anchorState && !anchorState.found) {
    return { messages: [], total, hasMore: false };
  }
  return {
    messages: collected.slice(0, limit).reverse(),
    total,
    hasMore: collected.length > limit,
  };
}

// ─── MessagesQueryStore 类 ───

export class MessagesQueryStore {
  private readonly ctx: FileStoreCore;
  private readonly core: MessagesCoreStore;

  constructor(ctx: FileStoreCore, core: MessagesCoreStore) {
    this.ctx = ctx;
    this.core = core;
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
      const { rows } = await readJsonlTail({ file: this.core.messagesPath(channelId), limit: 1 });
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
      handle = await fs.promises.open(this.core.messagesPath(channelId), 'r');
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
      handle = await fs.promises.open(this.core.messagesPath(channelId), 'r');
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
      handle = await fs.promises.open(this.core.messagesPath(channelId), 'r');
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
      const entries = await this.ctx.io.readdirCached(this.core.channelsDir());
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
      handle = await fs.promises.open(this.core.messagesPath(channelId), 'r');
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
    // #524 P1-1 尾部快径（#514 第 4 子项）：limit 时倒扫切片，不付全量读/clone/归并税。
    // 窗口 createdAt 序列非严格递减（混入更新副本或等 ts 撞车 = 文件序≠时间序）→
    // 回退全量路径保精确（单副本必被严格性检查捕获；多副本交织的病态窗口理论上有界
    // 偏差，压实 #319 自愈）。
    // B5（2026-09-16 channel 体检）：limit 且带过滤 → 同一快径加谓词（倒扫按匹配计数
    // 早停）；无 limit 的带过滤查询无早停收益（倒扫亦需扫到文件头），保持全量路径。
    // #576：before（createdAt 严格 <）与 since（>=）互补，同为谓词一员。
    // #681：快径谓词与全量 filter 合一为 buildQueryFilter 唯一实现（原为逐句镜像两份）。
    const match = buildQueryFilter(opts);
    if (opts?.limit !== undefined && opts.limit > 0) {
      const { messages, exhausted } = await this.readMessagesTail(channelId, { limit: opts.limit, match });
      if (exhausted || isStrictlyDecreasingTs(messages)) {
        messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        return messages;
      }
    }
    const resolved = await this.core.resolveActiveMessages(channelId);
    const filtered = match ? resolved.filter(match) : resolved;

    // 按创建时间升序
    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (opts?.limit !== undefined && opts.limit > 0) {
      return filtered.slice(-opts.limit);
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
   *
   * #681 五镜像收敛：五个分支（热快径锚/冷链锚/全量无锚/全量热锚/全量冷锚）的
   * 「补冷循环 + 切片 + hasMore」镜像统一为单迭代器 iteratePageCandidates（热新→旧
   * 接冷、锚点跳过、惰性——热侧未穷举时冷流不启动，与原「exhausted/anchor<=limit 才
   * 读冷」的门槛逐条等价）+ assembleMessagePage 一次切片出页；分支本体只保留
   * 各自的热侧扫描/判据与 total 计算（pageTotal 唯一出口）。
   *
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
      // - 倒扫凑满 limit+1 ⟺ 活消息 > limit（hasMore 恒真、不补冷——迭代器惰性保证
      //   收集满 limit+1 时冷流不启动）；
      // - 未凑满即扫到文件头（exhausted）⟺ 活消息 ≤ limit，收集结果 = 全量活消息，
      //   补冷/去重/total 与原路径逐条一致；
      // - 窗口 createdAt 序列严格递减 = 窗口内无旧消息更新副本、无等 ts 撞车
      //   （文件序=时间序），首页 = createdAt 精确后缀，before 游标翻页链完整；
      //   非严格递减（窗口混入更新副本/等 ts）→ 回退下方全量路径保精确
      //   （单副本必被严格性检查捕获；多副本交织的病态窗口理论上有界偏差，
      //   压实 #319 清死行后自愈）。
      const tail = await this.readMessagesTail(channelId, { limit: limit + 1 });
      if (tail.exhausted || isStrictlyDecreasingTs(tail.messages)) {
        const total = await this.pageTotal(channelId, opts?.includeTotal, tail.exhausted ? tail.messages.length : null);
        return assembleMessagePage(
          this.pageStream(channelId, tail.messages, new Set(tail.messages.map(m => m.id)), undefined, { found: true }),
          limit, total);
      }
      // 严格性违例（窗口混入更新副本/等 ts 撞车）→ 落回下方全量路径
    } else {
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
      //   hotIds/activeCount 为精确全量，免 resolveActiveMessages）。
      const scan = await this.scanHotToAnchor(channelId, opts.before, limit);
      if (scan.found) {
        const anchorTs = new Date(scan.window[scan.anchorIdx].createdAt).getTime();
        let preAnchorNewer = true;
        for (let i = 0; i < scan.anchorIdx; i++) {
          if (new Date(scan.window[i].createdAt).getTime() <= anchorTs) { preAnchorNewer = false; break; }
        }
        const fromAnchor = scan.window.slice(scan.anchorIdx);
        if (preAnchorNewer && isStrictlyDecreasingTs(fromAnchor)) {
          const total = await this.pageTotal(channelId, opts?.includeTotal, scan.exhausted ? scan.activeCount : null);
          const anchorState: PageAnchorState = { found: false };
          return assembleMessagePage(
            this.pageStream(channelId, scan.window, scan.hotIds, opts.before, anchorState),
            limit, total, anchorState);
        }
        // 判据违例 → 落回下方全量路径
      } else {
        // 锚不在热层（倒扫已穷举热文件）：锚在冷或不存在——迭代器直走冷链锚段，
        // 多收 limit+1 条即停；扫完未命中 = 锚不存在 → 空页 + hasMore=false
        const total = await this.pageTotal(channelId, opts?.includeTotal, scan.activeCount);
        const anchorState: PageAnchorState = { found: false };
        return assembleMessagePage(
          this.pageStream(channelId, [], scan.hotIds, opts.before, anchorState),
          limit, total, anchorState);
      }
    }

    // 全量回退路径（快径判据违例）：热侧物化 + createdAt 升序排序后接同一迭代器/切片出口
    const resolved = await this.core.resolveActiveMessages(channelId);
    // 按创建时间升序（与 queryMessages 同口径；同刻消息按文件序稳定排列）
    resolved.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const hotIds = new Set(resolved.map(m => m.id));
    const total = await this.pageTotal(channelId, opts?.includeTotal, resolved.length);
    const anchorState: PageAnchorState = { found: false };
    return assembleMessagePage(
      this.pageStream(channelId, [...resolved].reverse(), hotIds, opts?.before, anchorState),
      limit, total, opts?.before ? anchorState : undefined);
  }

  /**
   * 分页候选流（单迭代器接线点）：热侧候选（新→旧）接冷链惰性流。
   * 热侧未穷举时 hotIds 只是部分集——此时候选收集必在热段凑满 limit+1
   * （assembleMessagePage break），冷流永不启动，部分 hotIds 不参与判重
   * （与原「exhausted / anchor<=limit 才读冷」门槛逐条等价）。
   */
  private pageStream(
    channelId: string,
    hotNewToOld: ChannelMessageData[],
    hotIds: Set<string>,
    anchorId: string | undefined,
    anchorState: PageAnchorState,
  ): AsyncGenerator<ChannelMessageData> {
    return iteratePageCandidates(hotNewToOld, this.iterateColdMessages(channelId, hotIds), anchorId, anchorState);
  }

  /**
   * total 三分支口径唯一计算点（#681 收敛；#525 P2-4 语义不变）：
   * includeTotal 缺省 false → 恒 0 且完全跳过 countFileLines/countColdLines；
   * exactHotActive 非 null（热侧已穷举）= 精确活跃数；null = 热部走 countFileLines
   * 字节快扫原始行数（死行虚高，方向安全偏多——与冷侧「thaw/崩溃残留行计入」同口径）。
   */
  private async pageTotal(channelId: string, includeTotal: boolean | undefined, exactHotActive: number | null): Promise<number> {
    if (!includeTotal) return 0;
    const hot = exactHotActive ?? await this.countFileLines(this.core.messagesPath(channelId));
    return hot + await this.countColdLines(channelId);
  }

  /**
   * 冷链惰性遍历（新→旧，候选 8）：逐月读（读穿缓存摊销），月内 createdAt 降序；
   * 热侧 id 遮蔽冷侧残留 + 冷内同 id 先见为准。调用方 break 即停——后面的冷月不读，
   * 分页成本与页深成正比而非与全历史成正比。
   */
  private async *iterateColdMessages(channelId: string, hotIds: Set<string>): AsyncGenerator<ChannelMessageData> {
    const seenCold = new Set<string>();
    for (const month of await this.listArchiveMonths(channelId)) {
      const rows = await this.ctx.io.readJsonl<ChannelMessageData>(this.core.archiveMonthPath(channelId, month));
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
      total += await this.countFileLines(this.core.archiveMonthPath(channelId, month));
    }
    return total;
  }

  /** 冷文件月清单（YYYY-MM，新→旧）；无 archive 目录 → []（包内公开：归档层解冻预检共用） */
  public async listArchiveMonths(channelId: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await this.ctx.io.readdirCached(this.core.archiveDir(channelId));
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

  /**
   * 跨频道查询消息（扫描所有 channel 的 messages.jsonl）。
   * 支持按 workUnitId(s) 和 authorType 过滤。
   * #330：可选 channelIds 预过滤——提供时 readdir 后跳过集合外频道（不读其文件），
   * 供 observe 巡查只扫活跃 WU 所在频道；缺省全扫，既有调用方行为不变。
   */
  async queryAllMessages(filter?: { workUnitIds?: string[]; workUnitId?: string; authorType?: string; agentName?: string; agentNames?: string[]; channelIds?: string[] }): Promise<ChannelMessageData[]> {
    const result: ChannelMessageData[] = [];
    const dir = this.core.channelsDir();
    try {
      const entries = await this.ctx.io.readdirCached(dir);
      const channelSet = filter?.channelIds ? new Set(filter.channelIds) : null;
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return [];
        if (channelSet && !channelSet.has(entry.name)) return [];
        const active = await this.core.resolveActiveMessages(entry.name);
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
        handle = await fs.promises.open(this.core.messagesPath(channelId), 'r');
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
    const dir = this.core.channelsDir();
    try {
      const entries = await this.ctx.io.readdirCached(dir);
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        // #360：与 queryMessages 同走 mergeActiveRows 唯一归并口径（原为 inline 重复折叠）
        const active = mergeActiveRows(await this.ctx.io.readJsonl<ChannelMessageRow>(this.core.messagesPath(entry.name)));
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
