// 频道消息流渲染管线（#322）：deriveStreamView —— 输入消息集 + 折叠/筛选 UI 状态，
// 输出渲染段直接消费的 items 视图模型序列（归组、过程消息折叠、连续合并、日期分隔、可见性全部算好）。
// 实现整块迁自 ChannelDetailPage 渲染段（groupIntoThreads / collapseProcessReplies / shouldOmitHead +
// 内联 filter/sort/日期分隔），行为零变化；折叠 UI 状态由组件持有，本模块纯计算。
import type { ChannelMessage } from '../api/channel';
import { parseMeta } from './messageMeta';
import { parseSeverityPrefix } from './severityPrefix';

/** 折叠/筛选 UI 状态（组件持有，管线只消费） */
export interface StreamUiState {
  /** 已完成消息全量展开（false = 只留最近 2 条） */
  showCompleted: boolean;
  /** 收起的线程锚点 id 集（2026-09 折叠层级 4→2：默认空 = 全部线程展开，用户可手动收起） */
  collapsedThreads: ReadonlySet<string>;
  /** 展开的过程消息组 key 集（key = proc-<首条消息 id>） */
  expandedProcGroups: ReadonlySet<string>;
  /** Phase 3（AC3）：展开的告警组 key 集（key = alerts-<首条消息 id>；缺省空 = 全部折叠） */
  expandedAlertGroups: ReadonlySet<string>;
  /** #279（走查 F4）：提升主流的当前提问消息 id 集（不进折叠线程、不参与合并） */
  promotedQuestionIds: ReadonlySet<string>;
  /** F5: 消息是否为关联 WU 的当前提问（里程碑判定输入） */
  isWaitingForInput: (m: ChannelMessage) => boolean;
}

/** 线程内回复渲染项：单条消息，或被折叠的连续过程消息组 */
export type ThreadReplyView =
  | { kind: 'msg'; message: ChannelMessage; compact: boolean }
  | { kind: 'proc-group'; key: string; messages: ChannelMessage[]; expanded: boolean };

/** 主流渲染项：普通消息或线程组（日期分隔/合并头全部算好） */
export type StreamItem =
  | {
      kind: 'message';
      message: ChannelMessage;
      showDate: boolean;
      /** 日期分隔元素 key（`date-${message.id}`） */
      dateKey: string;
      /** 日期分隔文案（今天/昨天/M月D日） */
      dateLabel: string;
      compact: boolean;
    }
  | {
      kind: 'thread';
      anchor: ChannelMessage;
      replyCount: number;
      expanded: boolean;
      showDate: boolean;
      dateKey: string;
      dateLabel: string;
      compact: boolean;
      /** 仅 expanded 时计算（折叠态为空数组） */
      replies: ThreadReplyView[];
    }
  | {
      /** Phase 3（AC3）：主流连续 ≥3 条 monitor 告警的折叠组（单条摘要行，可展开） */
      kind: 'alert-group';
      /** 组 key（`alerts-<首条消息 id>`），expandedAlertGroups 持久化键 */
      key: string;
      messages: ChannelMessage[];
      criticalCount: number;
      warningCount: number;
      expanded: boolean;
      showDate: boolean;
      dateKey: string;
      dateLabel: string;
      compact: boolean;
    };

export interface StreamView {
  items: StreamItem[];
  /** 已完成消息总数（> 2 时渲染折叠 toggle，文案用 completedCount - 2） */
  completedCount: number;
  /** 非枚举版本号：items 原地变更时仍驱动 React memo/effect。 */
  revision: number;
}

function makeStreamView(items: StreamItem[], completedCount: number, revision = 0): StreamView {
  const view = { items, completedCount, revision };
  Object.defineProperty(view, 'revision', { enumerable: false, writable: true, value: revision });
  return view;
}

// ── 以下为迁移自 ChannelDetailPage 的纯计算（行为零变化） ──────────────

function isToday(d: Date) {
  const now = new Date();
  return d.toDateString() === now.toDateString();
}
function isYesterday(d: Date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

/** AC-C3: Group messages into threads (anchor + replies)
 *  #279（走查 F4）：promoteIds 命中的线程回复提升到主流（agent 追问主流可见，不只在折叠线程里）
 *  Phase 2（2026-09 channel 上下游优化 AC2）归组泛化：任意被回复消息可成 anchor（不限 WU），
 *  多层回复沿 replyToId 链拍平进线程根；链断裂（父消息未加载）落主流兜底 */
interface ThreadGroup {
  anchor: ChannelMessage;
  replies: ChannelMessage[];
}

/**
 * Phase 2（AC2）：沿 replyToId 链向上解析线程根 id（链顶 = replyToId 为 null 的祖先）。
 * 自身无 replyToId / 链断裂（祖先未加载）/ 成环 → null。
 * 页面定位链路（展开目标所在线程）与 groupIntoThreads 共用本函数，不复制逻辑。
 */
export function rootAnchorIdOf(msg: ChannelMessage, byId: ReadonlyMap<string, ChannelMessage>): string | null {
  if (!msg.replyToId) return null;
  const seen = new Set<string>([msg.id]);
  let cur = msg.replyToId;
  for (;;) {
    if (seen.has(cur)) return null; // 成环防御
    seen.add(cur);
    const parent = byId.get(cur);
    if (!parent) return null; // 父消息未加载（链断裂）
    if (!parent.replyToId) return parent.id; // 链顶即线程根
    cur = parent.replyToId;
  }
}

function groupIntoThreads(messages: ChannelMessage[], promoteIds?: ReadonlySet<string>): Array<ChannelMessage | ThreadGroup> {
  // 第一遍：id → msg 索引 + hasReplies（所有 replyToId 集合，anchor 判定输入）
  const byId = new Map<string, ChannelMessage>();
  const hasReplies = new Set<string>();
  for (const msg of messages) {
    byId.set(msg.id, msg);
    if (msg.replyToId) hasReplies.add(msg.replyToId);
  }

  // 第二遍：归组。anchor = 无 replyToId 且（关联 WU 或被回复过）；
  // 回复 = 沿链挂最近线程根（promote 命中的中间节点在主流，链透过它继续向上）
  const anchorMap = new Map<string, ThreadGroup>();
  const result: Array<ChannelMessage | ThreadGroup> = [];

  for (const msg of messages) {
    if (!msg.replyToId && (msg.workUnitId || hasReplies.has(msg.id))) {
      const group: ThreadGroup = { anchor: msg, replies: [] };
      anchorMap.set(msg.id, group);
      result.push(group);
    } else if (msg.replyToId && !promoteIds?.has(msg.id)) {
      const rootId = rootAnchorIdOf(msg, byId);
      const group = rootId ? anchorMap.get(rootId) : undefined;
      if (group) {
        group.replies.push(msg);
      } else {
        // 根未加载/未先出现（时序倒序）→ 落主流当普通消息（兜底）
        result.push(msg);
      }
    } else {
      // Regular message (no thread)：含 promote 命中的回复
      result.push(msg);
    }
  }

  return result;
}

/**
 * #277（决策 #248 D2）：连续消息合并——同作者（authorType + agentName）5 分钟内、
 * 同线程/主流内、未参与折叠的连续消息省略重复头（Slack 式）。
 * 系统播报（Studio 署名无卡）与卡片消息不参与合并（既不并入别人，别人也不并入它）。
 */
const MERGE_WINDOW_MS = 5 * 60 * 1000;

function mergeable(m: ChannelMessage): boolean {
  return !parseMeta(m.meta).cardType && !(m.authorType === 'agent' && m.agentName === 'Studio');
}

function shouldOmitHead(prev: ChannelMessage | null, cur: ChannelMessage): boolean {
  if (!prev || !mergeable(prev) || !mergeable(cur)) return false;
  if (prev.authorType !== cur.authorType || (prev.agentName ?? '') !== (cur.agentName ?? '')) return false;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() <= MERGE_WINDOW_MS;
}

/**
 * Phase 3（AC3）：monitor 告警判定——Studio 署名系统播报 + 无卡片 + 非 NEED_INPUT 等待中
 * + 行首 [CRITICAL]/[WARNING] 前缀（D-1.5 parseSeverityPrefix 同口径；[INFO]/无前缀不折叠，
 * 维持 docs/plans/2026-09-channel-upstream-downstream-ux.md「误伤排除」决策）。
 */
export function isMonitorAlert(m: ChannelMessage, isWaitingForInput: (m: ChannelMessage) => boolean): boolean {
  if (m.authorType !== 'agent' || m.agentName !== 'Studio') return false;
  if (parseMeta(m.meta).cardType) return false;
  if (isWaitingForInput(m)) return false;
  return parseSeverityPrefix(m.content) !== null;
}

/** 线程回复折叠中间件：单条消息，或被折叠的连续过程消息组 */
type ReplyItem =
  | { kind: 'msg'; msg: ChannelMessage }
  | { kind: 'group'; key: string; messages: ChannelMessage[] };

/**
 * 线程内过程消息折叠/聚合：连续 ≥3 条「过程消息」收成一组（默认折叠，点击展开）。
 * 里程碑消息不折叠：人类消息、卡片消息、等待回复（NEED_INPUT）、最后一条回复（最新状态）。
 */
function collapseProcessReplies(
  replies: ChannelMessage[],
  isMilestone: (m: ChannelMessage, isLast: boolean) => boolean,
): ReplyItem[] {
  const items: ReplyItem[] = [];
  let run: ChannelMessage[] = [];
  const flush = () => {
    if (run.length >= 3) {
      items.push({ kind: 'group', key: `proc-${run[0].id}`, messages: run });
    } else {
      for (const m of run) items.push({ kind: 'msg', msg: m });
    }
    run = [];
  };
  replies.forEach((m, i) => {
    if (isMilestone(m, i === replies.length - 1)) {
      flush();
      items.push({ kind: 'msg', msg: m });
    } else {
      run.push(m);
    }
  });
  flush();
  return items;
}

/** B2-006: 已完成判定（meta.status 终态） */
const COMPLETED_STATUSES = ['done', 'confirmed', 'rejected', 'deprecated', 'error'];

function isCompleted(m: ChannelMessage): boolean {
  const status = parseMeta(m.meta).status;
  return typeof status === 'string' && COMPLETED_STATUSES.includes(status);
}

// F1③（2026-09-16 性能体检）：toLocaleDateString 走 Intl 偏贵，按消息 id+createdAt 缓存
// （createdAt 不可变诞生时刻，#317 ADR 2026-08-24；键带上 createdAt 对同 id 不同时间戳的
// 测试夹具也安全）；长会话跨频道累积防御——超上限整体清空重建（简单优先，不做 LRU）
const DATE_STR_CACHE_CAP = 10000;
const dateStrCache = new Map<string, string>();

const dateStrOf = (m: ChannelMessage) => {
  const key = `${m.id}:${m.createdAt}`;
  let s = dateStrCache.get(key);
  if (s === undefined) {
    if (dateStrCache.size >= DATE_STR_CACHE_CAP) dateStrCache.clear();
    s = new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    dateStrCache.set(key, s);
  }
  return s;
};

const dateLabelOf = (m: ChannelMessage, dateStr: string) => {
  const d = new Date(m.createdAt);
  return isToday(d) ? '今天' : isYesterday(d) ? '昨天' : dateStr;
};

/** Phase 3（AC3）：组内跨天时展开态的组内日期分隔用——页面渲染段逐条比较日期串 */
export const streamDateStrOf = dateStrOf;
export const streamDateLabelOf = dateLabelOf;

type MessageStreamItem = Extract<StreamItem, { kind: 'message' }>;

/**
 * Phase 3（AC3）：主流告警聚合 pass——连续 ≥3 条 isMonitorAlert 的 message 项收成 alert-group。
 * 在日期分隔/连续合并计算**之后**跑：组继承首条消息的 showDate/dateKey/dateLabel/compact
 * 参与主流日期分隔（组后项的分隔/合并在聚合前已按逐条算好，无需重算）；
 * 组内若跨天，展开时组内逐条自渲染日期分隔（折叠摘要行只按首条日期站位）。
 * 连续段被任何非 alert 项（含 thread）打断；不足 3 条原样放回。
 */
function foldAlertGroups(
  items: StreamItem[],
  expandedAlertGroups: ReadonlySet<string>,
  isWaitingForInput: (m: ChannelMessage) => boolean,
): StreamItem[] {
  const out: StreamItem[] = [];
  let run: MessageStreamItem[] = [];
  const flush = () => {
    if (run.length < 3) {
      out.push(...run);
    } else {
      const messages = run.map(i => i.message);
      let criticalCount = 0;
      let warningCount = 0;
      for (const m of messages) {
        // isMonitorAlert 已保证前缀命中，此处仅分桶计数
        if (parseSeverityPrefix(m.content)?.level === 'critical') criticalCount += 1;
        else warningCount += 1;
      }
      const first = run[0];
      const key = `alerts-${first.message.id}`;
      out.push({
        kind: 'alert-group',
        key,
        messages,
        criticalCount,
        warningCount,
        expanded: expandedAlertGroups.has(key),
        showDate: first.showDate,
        dateKey: first.dateKey,
        dateLabel: first.dateLabel,
        compact: false, // 组不参与连续合并（Studio 播报本就不 mergeable）
      });
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'message' && !item.message.degraded && isMonitorAlert(item.message, isWaitingForInput)) {
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/**
 * 消息流管线单一入口：messages + UI 状态 → 渲染就绪 items。
 * 消息引用不变则输出可整树跳过（组件侧 useMemo 消费）。
 */
type BaseStreamItem = Exclude<StreamItem, { kind: 'alert-group' }>;

interface StreamViewParts {
  baseItems: BaseStreamItem[];
  completedCount: number;
}

function deriveStreamViewParts(messages: ChannelMessage[], uiState: StreamUiState): StreamViewParts {
  const { showCompleted, collapsedThreads, expandedProcGroups, promotedQuestionIds, isWaitingForInput } = uiState;

  // B2-006: 已完成折叠——默认活跃全留 + 最近 2 条已完成
  // F1①②（2026-09-16 性能体检）：completed 建 Set 单遍过滤（旧 completed.includes 为 O(n×c)）；
  // store 保证 messages 恒按 createdAt 升序（channelMessageStore 升序不变量测试锁定），
  // filter 保序故免全量 sort；乱序输入兜底排序，保持旧契约不变
  const completed = messages.filter(isCompleted);
  const completedIds = new Set(completed.map(m => m.id));
  const keepCompletedIds = new Set(completed.slice(-2).map(m => m.id));
  const filtered = showCompleted
    ? messages
    : messages.filter(m => !completedIds.has(m.id) || keepCompletedIds.has(m.id));
  let visibleMessages = filtered;
  for (let i = 1; i < filtered.length; i++) {
    if (new Date(filtered[i - 1].createdAt).getTime() > new Date(filtered[i].createdAt).getTime()) {
      visibleMessages = [...filtered].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      break;
    }
  }

  // Re-group visible messages into threads（#279：当前提问消息提升主流，不进折叠线程）
  const grouped = groupIntoThreads(visibleMessages, promotedQuestionIds);

  // 每项（线程组取 anchor）的代表消息与日期串：日期分隔/合并判定均按可见项纯比较
  const itemMsgs = grouped.map(item => ('anchor' in item ? item.anchor : item));
  const itemDateStrs = itemMsgs.map(dateStrOf);

  // 里程碑判定（不折叠）：人类消息 / 卡片消息 / 等待回复 / 最后一条回复
  const isMilestoneReply = (m: ChannelMessage, isLast: boolean) => {
    if (isLast || m.authorType === 'human' || isWaitingForInput(m)) return true;
    return !!parseMeta(m.meta).cardType;
  };

  const items: BaseStreamItem[] = grouped.map((item, idx) => {    const m = itemMsgs[idx];
    const dateStr = itemDateStrs[idx];
    const showDate = idx === 0 || dateStr !== itemDateStrs[idx - 1];
    // #277 D2：主流连续合并（日期分隔线切断；线程组以其 anchor 参与主流序列）
    // #279：提升主流的当前提问消息不参与合并（badge/选项卡需要完整头，且不被前一条吃掉）
    const compact = (promotedQuestionIds.has(m.id) || promotedQuestionIds.has(itemMsgs[idx - 1]?.id ?? ''))
      ? false
      : !showDate && shouldOmitHead(itemMsgs[idx - 1] ?? null, m);
    const base = {
      showDate,
      dateKey: `date-${m.id}`,
      dateLabel: dateLabelOf(m, dateStr),
      compact,
    };
    if ('anchor' in item) {
      // 线程默认展开（collapsedThreads 只存手动收起的锚点）
      const expanded = !collapsedThreads.has(item.anchor.id);
      // 线程内回复渲染项仅在展开时计算（收起态不付出折叠/合并成本）
      let replies: ThreadReplyView[] = [];
      if (expanded && item.replies.length > 0) {
        // #277 D2：线程内同作者连续回复合并；折叠组切断合并，组内消息参与过折叠不省头
        let prevReply: ChannelMessage | null = null;
        replies = collapseProcessReplies(item.replies, isMilestoneReply).map(ri => {
          if (ri.kind === 'msg') {
            const compactReply = shouldOmitHead(prevReply, ri.msg);
            prevReply = ri.msg;
            return { kind: 'msg', message: ri.msg, compact: compactReply };
          }
          prevReply = null;
          return { kind: 'proc-group', key: ri.key, messages: ri.messages, expanded: expandedProcGroups.has(ri.key) };
        });
      }
      return {
        kind: 'thread',
        anchor: item.anchor,
        replyCount: item.replies.length,
        expanded,
        replies,
        ...base,
      };
    }
    return { kind: 'message', message: item, ...base };
  });

  return { baseItems: items, completedCount: completed.length };
}

/** 全量入口：首拉、分页/结构重置和 UI 折叠状态变化使用。 */
export function deriveStreamView(messages: ChannelMessage[], uiState: StreamUiState): StreamView {
  const parts = deriveStreamViewParts(messages, uiState);
  return makeStreamView(
    foldAlertGroups(parts.baseItems, uiState.expandedAlertGroups, uiState.isWaitingForInput),
    parts.completedCount,
  );
}

function baseMessageOf(item: BaseStreamItem): ChannelMessage {
  return item.kind === 'thread' ? item.anchor : item.message;
}

function baseMessageIdsOf(item: BaseStreamItem): string[] {
  if (item.kind === 'message') return [item.message.id];
  const ids = [item.anchor.id];
  for (const reply of item.replies) {
    if (reply.kind === 'msg') ids.push(reply.message.id);
    else for (const message of reply.messages) ids.push(message.id);
  }
  return ids;
}

function isAlertBase(item: BaseStreamItem, ui: StreamUiState): boolean {
  return item.kind === 'message' && !item.message.degraded && isMonitorAlert(item.message, ui.isWaitingForInput);
}

function decorateBaseItem(item: BaseStreamItem, previous: BaseStreamItem | undefined, index: number, ui: StreamUiState): BaseStreamItem {
  const message = baseMessageOf(item);
  const prevMessage = previous ? baseMessageOf(previous) : null;
  const dateStr = dateStrOf(message);
  const showDate = index === 0 || !previous || dateStr !== dateStrOf(prevMessage!);
  const compact = (ui.promotedQuestionIds.has(message.id) || ui.promotedQuestionIds.has(prevMessage?.id ?? ''))
    ? false
    : !showDate && shouldOmitHead(prevMessage, message);
  return { ...item, showDate, dateKey: `date-${message.id}`, dateLabel: dateLabelOf(message, dateStr), compact };
}

export interface StreamDerivationStats {
  fullDerives: number;
  patchCount: number;
  derivedMessages: number;
}

/**
 * PERF-06 增量视图：完整派生只发生在首拉/结构重置；append/update 重建目标线程，
 * 并重算相邻日期/合并项及受影响告警段。输入必须是 store 提供的单调 append 或单点 update。
 */
export class StreamViewDerivation {
  readonly stats: StreamDerivationStats = { fullDerives: 0, patchCount: 0, derivedMessages: 0 };
  private messages: ChannelMessage[];
  private byId = new Map<string, ChannelMessage>();
  private positions = new Map<string, number>();
  private threadIndex = new Map<string, string[]>();
  private waitingParents = new Set<string>();
  private completedIds: string[] = [];
  private baseItems: BaseStreamItem[] = [];
  private baseIndex = new Map<string, BaseStreamItem>();
  private finalIndex = new Map<string, StreamItem>();
  private completedCount = 0;
  view: StreamView;

  constructor(messages: ChannelMessage[], private ui: StreamUiState) {
    this.messages = messages;
    this.view = makeStreamView([], 0);
    this.reset(messages, ui);
  }

  reset(messages: ChannelMessage[], ui: StreamUiState): StreamView {
    if (this.stats.fullDerives > 0 && messages === this.messages && ui === this.ui) return this.view;
    return this.rebuild(messages, ui);
  }

  private rebuild(messages: ChannelMessage[], ui: StreamUiState): StreamView {
    this.messages = messages;
    this.ui = ui;
    const parts = deriveStreamViewParts(messages, ui);
    this.baseItems = parts.baseItems;
    this.completedCount = parts.completedCount;
    this.byId = new Map(messages.map(m => [m.id, m]));
    this.positions = new Map(messages.map((m, i) => [m.id, i]));
    this.threadIndex = new Map();
    this.waitingParents = new Set();
    this.completedIds = messages.filter(isCompleted).map(m => m.id);
    for (const message of messages) {
      const rootId = rootAnchorIdOf(message, this.byId) ?? (!message.replyToId ? message.id : null);
      if (rootId) {
        const ids = this.threadIndex.get(rootId) ?? [];
        ids.push(message.id);
        this.threadIndex.set(rootId, ids);
      } else if (message.replyToId) {
        this.waitingParents.add(message.replyToId);
      }
    }
    this.view = makeStreamView(
      foldAlertGroups(this.baseItems, ui.expandedAlertGroups, ui.isWaitingForInput),
      parts.completedCount,
      this.view.revision + 1,
    );
    this.rebuildIndexes();
    this.stats.fullDerives += 1;
    this.stats.derivedMessages += messages.length;
    return this.view;
  }

  private rebuildIndexes(): void {
    this.baseIndex = new Map();
    for (const item of this.baseItems) {
      for (const id of baseMessageIdsOf(item)) this.baseIndex.set(id, item);
    }
    this.finalIndex = new Map();
    for (const item of this.view.items) {
      if (item.kind === 'alert-group') for (const message of item.messages) this.finalIndex.set(message.id, item);
      else for (const id of baseMessageIdsOf(item)) this.finalIndex.set(id, item);
    }
  }

  private basePositionOf(item: BaseStreamItem): number {
    const position = this.positions.get(baseMessageOf(item).id) ?? Number.MAX_SAFE_INTEGER;
    let lo = 0;
    let hi = this.baseItems.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.positions.get(baseMessageOf(this.baseItems[mid]).id) ?? Number.MAX_SAFE_INTEGER;
      if (other < position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private finalPositionOf(item: StreamItem): number {
    const representative = item.kind === 'alert-group' ? item.messages[0] : baseMessageOf(item);
    const position = this.positions.get(representative.id) ?? Number.MAX_SAFE_INTEGER;
    let lo = 0;
    let hi = this.view.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const current = this.view.items[mid];
      const message = current.kind === 'alert-group' ? current.messages[0] : baseMessageOf(current);
      const other = this.positions.get(message.id) ?? Number.MAX_SAFE_INTEGER;
      if (other < position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  append(messages: ChannelMessage[], ui: StreamUiState, id: string): StreamView {
    if (messages === this.messages) return this.view;
    const previousLength = this.messages.length;
    const appended = messages[messages.length - 1];
    if (messages.length !== previousLength + 1 || appended?.id !== id || (previousLength > 0 && messages[previousLength - 1] !== this.messages[previousLength - 1])) {
      return this.rebuild(messages, ui);
    }
    return this.patch(messages, ui, id, true);
  }

  update(messages: ChannelMessage[], ui: StreamUiState, id: string): StreamView {
    if (messages === this.messages) return this.view;
    const position = this.positions.get(id);
    const previous = this.byId.get(id);
    const next = position === undefined ? undefined : messages[position];
    if (!previous || !next || next.id !== id || messages.length !== this.messages.length) return this.rebuild(messages, ui);
    if (previous.replyToId !== next.replyToId || previous.workUnitId !== next.workUnitId || previous.createdAt !== next.createdAt) {
      return this.rebuild(messages, ui);
    }
    return this.patch(messages, ui, id, false);
  }

  private patch(messages: ChannelMessage[], ui: StreamUiState, id: string, append: boolean): StreamView {
    if (append && this.waitingParents.has(id)) return this.rebuild(messages, ui);
    const previousKeep = new Set(this.completedIds.slice(-2));
    const previous = this.byId.get(id);
    const position = append ? messages.length - 1 : this.positions.get(id)!;
    const nextMessage = messages[position];
    if (isCompleted(previous ?? nextMessage) !== isCompleted(nextMessage)) return this.rebuild(messages, ui);
    this.messages = messages;
    this.ui = ui;
    this.byId.set(id, nextMessage);
    this.positions.set(id, position);
    const rootId = rootAnchorIdOf(nextMessage, this.byId) ?? id;
    const thread = this.threadIndex.get(rootId) ?? [];
    if (!thread.includes(id)) thread.push(id);
    this.threadIndex.set(rootId, thread);
    this.waitingParents.delete(nextMessage.replyToId ?? '');

    const wasCompleted = previous ? isCompleted(previous) : false;
    const nowCompleted = isCompleted(nextMessage);
    if (!wasCompleted && nowCompleted) {
      let lo = 0;
      let hi = this.completedIds.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((this.positions.get(this.completedIds[mid]) ?? Number.MAX_SAFE_INTEGER) < position) lo = mid + 1;
        else hi = mid;
      }
      this.completedIds.splice(lo, 0, id);
    }
    if (wasCompleted && !nowCompleted) {
      let lo = 0;
      let hi = this.completedIds.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((this.positions.get(this.completedIds[mid]) ?? Number.MAX_SAFE_INTEGER) < position) lo = mid + 1;
        else hi = mid;
      }
      if (this.completedIds[lo] === id) this.completedIds.splice(lo, 1);
    }
    this.completedCount += nowCompleted === wasCompleted ? 0 : nowCompleted ? 1 : -1;
    const nextKeep = new Set(this.completedIds.slice(-2));
    const affected = new Set<string>([id]);
    if (!ui.showCompleted) {
      for (const completedId of previousKeep) if (!nextKeep.has(completedId)) affected.add(completedId);
      for (const completedId of nextKeep) if (!previousKeep.has(completedId)) affected.add(completedId);
    }

    const roots = new Set([...affected].map(messageId => {
      const message = this.byId.get(messageId);
      return message ? rootAnchorIdOf(message, this.byId) ?? messageId : messageId;
    }));
    for (const root of roots) {
      const ids = this.threadIndex.get(root) ?? [root];
      if (ids.some(messageId => ui.promotedQuestionIds.has(messageId))) return this.rebuild(messages, ui);
    }
    for (const root of roots) this.patchRoot(root, append);
    this.stats.patchCount += 1;
    return this.view;
  }

  private patchRoot(rootId: string, append: boolean): void {
    const ids = this.threadIndex.get(rootId) ?? [rootId];
    const keepCompleted = new Set(this.completedIds.slice(-2));
    const groupMessages = ids.map(id => this.byId.get(id)).filter((m): m is ChannelMessage => !!m)
      .filter(m => this.ui.showCompleted || !isCompleted(m) || keepCompleted.has(m.id));
    const oldIndices = [...new Set(ids.map(id => this.baseIndex.get(id)).filter((item): item is BaseStreamItem => !!item)
      .map(item => this.basePositionOf(item)))].sort((a, b) => a - b);
    if (oldIndices.length === 0 && groupMessages.length === 0) return;
    // 非尾部新增可见项只可能来自隐藏 completed 的状态回退；按结构重置处理，避免错误插入顺序。
    if (oldIndices.length === 0 && !append) {
      this.rebuild(this.messages, this.ui);
      return;
    }
    const insertion = oldIndices[0] ?? this.baseItems.length;
    const oldStart = oldIndices[0] ?? insertion;
    const oldEnd = oldIndices[oldIndices.length - 1] ?? insertion - 1;
    let oldAlertStart = oldStart;
    let oldAlertEnd = oldEnd;
    while (oldAlertStart > 0 && isAlertBase(this.baseItems[oldAlertStart - 1], this.ui)) oldAlertStart -= 1;
    while (oldAlertEnd + 1 < this.baseItems.length && isAlertBase(this.baseItems[oldAlertEnd + 1], this.ui)) oldAlertEnd += 1;
    const oldFinalStartItem = oldIndices.length === 0 && oldAlertStart === insertion
      ? undefined
      : this.finalIndex.get(baseMessageOf(this.baseItems[oldAlertStart]).id);
    const oldFinalStart = oldFinalStartItem ? this.finalPositionOf(oldFinalStartItem) : this.view.items.length;
    const oldFinalEndItem = this.finalIndex.get(baseMessageOf(this.baseItems[oldAlertEnd]).id);
    let oldFinalEnd = oldFinalStart === this.view.items.length
      ? this.view.items.length - 1
      : oldFinalEndItem ? this.finalPositionOf(oldFinalEndItem) : this.view.items.length - 1;

    const replacement = groupMessages.length
      ? deriveStreamViewParts(groupMessages, { ...this.ui, showCompleted: true }).baseItems
      : [];
    this.stats.derivedMessages += groupMessages.length;
    const oldBaseSegment = this.baseItems.slice(oldStart, oldEnd + 1);
    const tailAppend = oldIndices.length === 0 && append && oldStart === this.baseItems.length;
    if ((!tailAppend && replacement.length !== oldBaseSegment.length) || (tailAppend && replacement.length !== 1)) {
      this.rebuild(this.messages, this.ui);
      return;
    }
    if (tailAppend) this.baseItems.push(replacement[0]);
    else for (let i = 0; i < replacement.length; i++) this.baseItems[oldStart + i] = replacement[i];
    const decorateStart = Math.max(0, Math.min(oldStart, insertion) - 1);
    const decorateEnd = Math.min(this.baseItems.length - 1, insertion + replacement.length);
    for (let i = decorateStart; i <= decorateEnd; i++) {
      const current = this.baseItems[i];
      const decorated = decorateBaseItem(current, this.baseItems[i - 1], i, this.ui);
      if (current.showDate !== decorated.showDate || current.dateKey !== decorated.dateKey
        || current.dateLabel !== decorated.dateLabel || current.compact !== decorated.compact) {
        this.baseItems[i] = decorated;
      }
    }

    if (replacement.length === 0 && oldStart < this.baseItems.length) {
      const next = this.finalIndex.get(baseMessageOf(this.baseItems[oldStart]).id);
      if (next) oldFinalEnd = Math.max(oldFinalEnd, this.finalPositionOf(next));
    }
    let finalBaseStart = Math.min(oldAlertStart, insertion);
    let finalBaseEnd = Math.max(oldAlertEnd, insertion + replacement.length - 1);
    while (finalBaseStart > 0 && isAlertBase(this.baseItems[finalBaseStart - 1], this.ui)) finalBaseStart -= 1;
    while (finalBaseEnd + 1 < this.baseItems.length && isAlertBase(this.baseItems[finalBaseEnd + 1], this.ui)) finalBaseEnd += 1;
    if (replacement.length === 0 && finalBaseEnd < this.baseItems.length) {
      const next = this.finalIndex.get(baseMessageOf(this.baseItems[finalBaseEnd]).id);
      if (next) oldFinalEnd = Math.max(oldFinalEnd, this.finalPositionOf(next));
    }
    const finalReplacement = foldAlertGroups(
      this.baseItems.slice(finalBaseStart, finalBaseEnd + 1),
      this.ui.expandedAlertGroups,
      this.ui.isWaitingForInput,
    );
    const oldFinalSegment = this.view.items.slice(oldFinalStart, oldFinalEnd + 1);
    if (finalReplacement.length !== oldFinalSegment.length && (!tailAppend || oldFinalSegment.length > 0)) {
      this.rebuild(this.messages, this.ui);
      return;
    }
    if (oldFinalSegment.length === 0) this.view.items.push(...finalReplacement);
    else for (let i = 0; i < finalReplacement.length; i++) this.view.items[oldFinalStart + i] = finalReplacement[i];
    this.view.completedCount = this.completedCount;
    this.view.revision += 1;
    this.patchIndexes(oldBaseSegment, oldFinalSegment, finalReplacement, decorateStart, decorateEnd);
  }

  private patchIndexes(
    oldBase: BaseStreamItem[],
    oldFinal: StreamItem[],
    finalReplacement: StreamItem[],
    decorateStart: number,
    decorateEnd: number,
  ): void {
    for (const item of oldBase) {
      for (const id of baseMessageIdsOf(item)) {
        if (this.baseIndex.get(id) === item) this.baseIndex.delete(id);
      }
    }
    for (const item of oldFinal) {
      const ids = item.kind === 'alert-group' ? item.messages.map(m => m.id) : baseMessageIdsOf(item);
      for (const id of ids) if (this.finalIndex.get(id) === item) this.finalIndex.delete(id);
    }
    for (let i = decorateStart; i <= decorateEnd; i++) {
      const item = this.baseItems[i];
      for (const id of baseMessageIdsOf(item)) this.baseIndex.set(id, item);
    }
    for (const item of finalReplacement) {
      if (item.kind === 'alert-group') for (const message of item.messages) this.finalIndex.set(message.id, item);
      else for (const id of baseMessageIdsOf(item)) this.finalIndex.set(id, item);
    }
  }
}

export function createStreamViewDerivation(messages: ChannelMessage[], ui: StreamUiState): StreamViewDerivation {
  return new StreamViewDerivation(messages, ui);
}

/**
 * Phase 3（AC5）：j/k 键盘导航的可导航消息 id 有序序列——
 * message / thread anchor / 展开的 thread replies（含展开的 proc-group 内消息）/ 展开的 alert-group 内消息；
 * 折叠组（收起 thread、折叠 proc-group、折叠 alert-group）与日期分隔跳过。
 */
export function navigableIdsOf(items: StreamItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.kind === 'message') {
      ids.push(item.message.id);
      continue;
    }
    if (item.kind === 'alert-group') {
      if (item.expanded) for (const m of item.messages) ids.push(m.id);
      continue;
    }
    ids.push(item.anchor.id);
    if (!item.expanded) continue;
    for (const r of item.replies) {
      if (r.kind === 'msg') ids.push(r.message.id);
      else if (r.expanded) for (const m of r.messages) ids.push(m.id);
    }
  }
  return ids;
}
