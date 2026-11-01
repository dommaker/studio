// Channel Message Store — #548 per-channelId 消息面数据面 store
// （ADR 2026-08-31-channel-data-plane-store 模式延伸；2026-09-15 架构评审候选 B4）。
// 收编前 messages 是 ChannelDetailPage 生命周期 state（useChannelMessages 本地 useState）——
// 五个数据面 store（roster/notification/unread/channelData/channelWork）就位后的最后一处例外。
// 本 store 是搬运不是发明：列表纯函数在 utils/messageList（insertMessage/mergePage），
// 降级判定在 utils/messagePruning（planPrune/degradeMessage），此处只做状态持有与接线。
// 行为口径 = 收编前 hook 本地 state 语义：
// - 首拉替换 / 同频道 refetch 合并（#328），hasMore 仅当本地最老消息落在最新一页内才以响应为准
//   （页的 hasMore 描述头部方向，直接覆盖会错误重置 prepend 方向状态）
// - SSE 逐条直写（写批处理已裁决不做，ADR 2026-09-12 实测帧成本 <1ms）：
//   message_sent 有序插入（#287）/ message_updated 全量本体优先、legacy 增量 patch（#315）
// - loadMore 以最老非 pending 消息 id 为游标 prepend（#319/#486）
// - sendMessage 乐观 pending：成功原位替换、失败回滚上抛（#486）
// - syncPruning 数据层降级（#326）：planPrune 判定 + 200ms 防抖整页水合（不触碰 hasMore）
import { create } from 'zustand';
import { channelApi, type ChannelMessage, type FileRef, type SendIntent } from '../api/channel';
// #665（ADR 2026-08-24 落地）：channel.message_updated 负载与 studio-contract 同源，本地声明清零
import type { ChannelMessageUpdatedPayload } from '@dommaker/studio-contract';
import { insertMessage, mergePage } from '../utils/messageList';
import {
  degradeMessage, planPrune,
  PRUNE_KEEP_RECENT, PRUNE_DEGRADE_DISTANCE, PRUNE_HYDRATE_DISTANCE, PRUNE_HYDRATE_PAGE_LIMIT,
  type PruneOptions,
} from '../utils/messagePruning';
import { markReceiptArrived } from '../utils/clientPerf';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';
import { rootAnchorIdOf } from '../utils/streamView';
import { KeyedCacheLifecycle } from './keyedCacheLifecycle';

export const CHANNEL_MESSAGE_CACHE_LIMIT = 8;
export const CHANNEL_MESSAGE_HISTORY_CAP = 10000;
export const CHANNEL_MESSAGE_INACTIVE_MS = 5 * 60 * 1000;

export type ChannelMessageChange =
  | { kind: 'reset' | 'structural' }
  | { kind: 'append' | 'update'; id: string };

/** per-channelId 消息切片（缺键 = 从未加载；消费方按「首拉进行中」渲染） */
export interface ChannelMessagesSlice {
  /** 恒按 createdAt 升序（下游 groupIntoThreads 单遍归组不变式） */
  messages: ChannelMessage[];
  /** SSE 点查/局部派生索引；Map 原地修补，不随消息对象复制。 */
  byId?: ReadonlyMap<string, ChannelMessage>;
  itemIndex?: ReadonlyMap<string, number>;
  threadIndex?: ReadonlyMap<string, string[]>;
  agentWorkUnitIds?: ReadonlySet<string>;
  change?: ChannelMessageChange;
  /** prepend 方向是否还有更早历史 */
  hasMore: boolean;
  /** cap 裁掉最老对象后仍单调前进的分页游标，避免重复请求同一页。 */
  beforeCursor?: string | null;
  loading: boolean;
  /** #482：首拉/兜底轮询失败暴露 error 态（页面据此区分加载失败/真空频道） */
  error: string | null;
  /** 首拉已完成（旧 loadedChannelRef 的 store 形态）——同频道 refetch 走合并，否则替换 */
  loaded: boolean;
}

interface MutableMessageIndex {
  byId: Map<string, ChannelMessage>;
  itemIndex: Map<string, number>;
  threadIndex: Map<string, string[]>;
  agentWorkUnitIds: Set<string>;
}

function buildMessageIndex(messages: ChannelMessage[]): MutableMessageIndex {
  const index: MutableMessageIndex = { byId: new Map(), itemIndex: new Map(), threadIndex: new Map(), agentWorkUnitIds: new Set() };
  messages.forEach((message, i) => {
    index.byId.set(message.id, message);
    index.itemIndex.set(message.id, i);
    if (message.authorType === 'agent' && message.workUnitId) index.agentWorkUnitIds.add(message.workUnitId);
  });
  for (const message of messages) {
    const rootId = rootAnchorIdOf(message, index.byId) ?? (!message.replyToId ? message.id : null);
    if (!rootId) continue;
    const ids = index.threadIndex.get(rootId) ?? [];
    ids.push(message.id);
    index.threadIndex.set(rootId, ids);
  }
  return index;
}

function indexFields(index: MutableMessageIndex) {
  return {
    byId: index.byId as ReadonlyMap<string, ChannelMessage>,
    itemIndex: index.itemIndex as ReadonlyMap<string, number>,
    threadIndex: index.threadIndex as ReadonlyMap<string, string[]>,
    agentWorkUnitIds: index.agentWorkUnitIds as ReadonlySet<string>,
  };
}

function indexOf(slice: ChannelMessagesSlice): MutableMessageIndex {
  if (slice.byId && slice.itemIndex && slice.threadIndex && slice.agentWorkUnitIds) {
    return {
      byId: slice.byId as Map<string, ChannelMessage>,
      itemIndex: slice.itemIndex as Map<string, number>,
      threadIndex: slice.threadIndex as Map<string, string[]>,
      agentWorkUnitIds: slice.agentWorkUnitIds as Set<string>,
    };
  }
  return buildMessageIndex(slice.messages);
}

function removeFromThreadIndex(index: MutableMessageIndex, message: ChannelMessage): void {
  const rootId = rootAnchorIdOf(message, index.byId) ?? (!message.replyToId ? message.id : null);
  if (!rootId) return;
  const ids = index.threadIndex.get(rootId);
  if (!ids) return;
  const next = ids.filter(id => id !== message.id);
  if (next.length) index.threadIndex.set(rootId, next);
  else index.threadIndex.delete(rootId);
}

function upsertIndex(index: MutableMessageIndex, message: ChannelMessage, position: number, previous?: ChannelMessage): void {
  if (previous) removeFromThreadIndex(index, previous);
  index.byId.set(message.id, message);
  index.itemIndex.set(message.id, position);
  if (message.authorType === 'agent' && message.workUnitId && !index.agentWorkUnitIds.has(message.workUnitId)) {
    index.agentWorkUnitIds = new Set(index.agentWorkUnitIds);
    index.agentWorkUnitIds.add(message.workUnitId);
  }
  const rootId = rootAnchorIdOf(message, index.byId) ?? (!message.replyToId ? message.id : null);
  if (!rootId) return;
  const ids = index.threadIndex.get(rootId) ?? [];
  if (!ids.includes(message.id)) ids.push(message.id);
  ids.sort((a, b) => (index.itemIndex.get(a) ?? 0) - (index.itemIndex.get(b) ?? 0));
  index.threadIndex.set(rootId, ids);
}

interface ChannelMessageState {
  channels: Record<string, ChannelMessagesSlice | undefined>;

  /** 频道切换复位：置 loading、清 error、保留已有消息（旧渲染期语义的 store 形态） */
  beginLoad: (channelId: string) => void;
  /** 首拉 / refetch（兜底轮询、重连、手动 refresh 共用）：loaded → 合并，否则替换 */
  fetchMessages: (channelId: string) => Promise<void>;
  ensureFresh: (opts?: { maxAgeMs?: number }) => Promise<void>;
  subscribeChannel: (channelId: string) => () => void;
  /** #290：返回是否真实前插（供调用方在失败/无更多时清理行锚点，防视口乱跳） */
  loadMore: (channelId: string) => Promise<boolean>;
  /** SSE channel.message_sent：有序插入 + id 去重（含 #520 回执计时起点） */
  applyMessageSent: (channelId: string, message: ChannelMessage) => void;
  /** SSE channel.message_updated：全量本体原位替换 / legacy 增量 patch */
  applyMessageUpdated: (channelId: string, data: ChannelMessageUpdatedPayload) => void;
  /** #486 乐观回显：成功返回服务端本体；失败回滚 pending + 上抛；空内容返回 null。
      #632：intent 透传归属预览条的显式选择（'new-task' / 'plain'；undefined = 自动合并判定） */
  sendMessage: (channelId: string, content: string, replyToId?: string, files?: FileRef[], intent?: SendIntent) => Promise<ChannelMessage | null>;
  /** #326：渲染侧在首个可见消息变化时调用（anchorMid = 首个可见消息 id，null = 无可锚行不动作） */
  syncPruning: (channelId: string, anchorMid: string | null, opts?: Partial<PruneOptions>) => void;
  /** 测试隔离：清数据面 + 纪律簿记 + 水合计时器（模块级 gate/timer 不在 zustand 内） */
  __resetForTests: () => void;
}

/** 缺省切片：loading=true（首拉进行中语义——SSE 先于首拉到达建切片时不同步闪空态） */
function freshSlice(): ChannelMessagesSlice {
  return { messages: [], ...indexFields(buildMessageIndex([])), hasMore: false, loading: true, error: null, loaded: false, change: { kind: 'reset' } };
}

// 纪律簿记按 channelId 模块级持有：数据在 zustand（消费方订阅），门禁状态不进响应式树
const book = new Map<string, { gate: FetchGate; state: FetchGateState }>();
const loadMoreGates = new Map<string, FetchGate>();
const loadMoreInflight = new Map<string, Promise<boolean>>();

function loadMoreGateOf(channelId: string): FetchGate {
  let gate = loadMoreGates.get(channelId);
  if (!gate) {
    gate = createFetchGate();
    loadMoreGates.set(channelId, gate);
  }
  return gate;
}

function gateOf(channelId: string): { gate: FetchGate; state: FetchGateState } {
  let s = book.get(channelId);
  if (!s) {
    s = { gate: createFetchGate(), state: { loadedAt: null, inflight: null } };
    book.set(channelId, s);
  }
  return s;
}

// 水合簿记按 channelId 模块级持有：防抖计时器 + in-flight 标记（旧 hook ref 的 store 形态；
// per-channel 后天然无跨频道污染，无需切频道清理）
const hydration = new Map<string, { timer: ReturnType<typeof setTimeout> | null; inFlight: boolean }>();
const hydrationGates = new Map<string, FetchGate>();
function hydrationGateOf(channelId: string): FetchGate {
  let gate = hydrationGates.get(channelId);
  if (!gate) {
    gate = createFetchGate();
    hydrationGates.set(channelId, gate);
  }
  return gate;
}

const lifecycle = new KeyedCacheLifecycle({
  maxInactive: CHANNEL_MESSAGE_CACHE_LIMIT,
  inactiveMs: CHANNEL_MESSAGE_INACTIVE_MS,
  onEvict: (channelId) => {
    book.get(channelId)?.gate.nextSeq();
    book.delete(channelId);
    loadMoreGates.get(channelId)?.nextSeq();
    loadMoreGates.delete(channelId);
    for (const key of loadMoreInflight.keys()) if (key.startsWith(`${channelId}:`)) loadMoreInflight.delete(key);
    const h = hydration.get(channelId);
    if (h?.timer) clearTimeout(h.timer);
    hydration.delete(channelId);
    hydrationGates.get(channelId)?.nextSeq();
    hydrationGates.delete(channelId);
    useChannelMessageStore.setState(st => {
      const channels = { ...st.channels };
      delete channels[channelId];
      return { channels };
    });
  },
});

export const CHANNEL_MESSAGE_CACHE_STATS = () => {
  let messages = 0;
  let indexedMessages = 0;
  for (const slice of Object.values(useChannelMessageStore.getState().channels)) {
    messages += slice?.messages.length ?? 0;
    indexedMessages += slice?.byId?.size ?? 0;
  }
  return {
    ...lifecycle.stats(),
    messages,
    indexedMessages,
    timers: lifecycle.stats().timers + [...hydration.values()].filter(h => h.timer).length,
  };
};

function hydrationOf(channelId: string): { timer: ReturnType<typeof setTimeout> | null; inFlight: boolean } {
  let h = hydration.get(channelId);
  if (!h) {
    h = { timer: null, inFlight: false };
    hydration.set(channelId, h);
  }
  return h;
}

function scheduleHydration(channelId: string, before: string): void {
  const h = hydrationOf(channelId);
  if (h.timer) clearTimeout(h.timer);
  h.timer = setTimeout(() => {
    h.timer = null;
    // in-flight 中不丢触发：重排等其落地后再取（防同区并发重复请求）
    if (h.inFlight) {
      scheduleHydration(channelId, before);
      return;
    }
    h.inFlight = true;
    const incarnation = lifecycle.incarnation(channelId);
    const gate = hydrationGateOf(channelId);
    const seq = gate.nextSeq();
    void (async () => {
      try {
        const res = await channelApi.listMessages(channelId, { before, limit: PRUNE_HYDRATE_PAGE_LIMIT });
        // 骨架原位复活（按 id 归并）；hasMore 不动——本路径与 prepend 方向无关
        useChannelMessageStore.setState(st => {
          const cur = st.channels[channelId];
          if (!cur || !gate.isLatest(seq) || lifecycle.incarnation(channelId) !== incarnation) return st;
          const window = capWithRecovery(cur, mergePage(cur.messages, res.data.data.messages));
          return { channels: { ...st.channels, [channelId]: { ...cur, ...window, ...indexFields(buildMessageIndex(window.messages)), change: { kind: 'structural' } } } };
        });
      } catch (err) {
        console.error('[Channel] Failed to hydrate messages', err);
      } finally {
        h.inFlight = false;
      }
    })();
  }, 200);
}

function capHistory(messages: ChannelMessage[]): ChannelMessage[] {
  return messages.length > CHANNEL_MESSAGE_HISTORY_CAP ? messages.slice(-CHANNEL_MESSAGE_HISTORY_CAP) : messages;
}

function capWithRecovery(slice: ChannelMessagesSlice, inserted: ChannelMessage[]): Pick<ChannelMessagesSlice, 'messages' | 'hasMore' | 'beforeCursor'> {
  const limit = inserted.some(m => m.degraded) ? CHANNEL_MESSAGE_HISTORY_CAP + 1 : CHANNEL_MESSAGE_HISTORY_CAP;
  const messages = inserted.length > limit ? inserted.slice(-limit) : inserted;
  if (messages.length < inserted.length && !slice.hasMore) {
    // 旧端被裁后允许重拉：before=新最老项的下一条，响应会包含被裁旧项及更早历史。
    return { messages, hasMore: true, beforeCursor: messages[1]?.id ?? messages[0]?.id ?? null };
  }
  return { messages, hasMore: slice.hasMore, beforeCursor: slice.beforeCursor ?? null };
}

export const useChannelMessageStore = create<ChannelMessageState>((set, get) => ({
  channels: {},

  beginLoad: (channelId) => {
    lifecycle.touch(channelId);
    set(st => {
      const cur = st.channels[channelId] ?? freshSlice();
      return { channels: { ...st.channels, [channelId]: { ...cur, loading: true, error: null } } };
    });
  },

  fetchMessages: (channelId) => {
    lifecycle.touch(channelId);
    const s = gateOf(channelId);
    // maxAgeMs: 0 = 恒拉（消息面无 TTL——取数时机归 useGatedPoll/重连/手动 refresh）；
    // 纪律底座提供 single-flight 簿记 + seq 守卫（晚到旧结果不落库）
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: 0 },
      async (seq) => {
        try {
          const res = await channelApi.listMessages(channelId);
          if (!s.gate.isLatest(seq) || !lifecycle.has(channelId)) return;
          set(st => {
            const cur = st.channels[channelId];
            if (cur?.loaded) {
              // 合并路径：prepend 的历史页不丢；hasMore 仅当本地最老消息落在最新一页内
              // （未 prepend 出页外）才以响应为准
              const oldest = cur.messages[0];
              const hasMore = !oldest || res.data.data.messages.some(m => m.id === oldest.id)
                ? res.data.data.hasMore
                : cur.hasMore;
              const merged = mergePage(cur.messages, res.data.data.messages);
              const messages = capHistory(merged);
              return {
                channels: {
                  ...st.channels,
                  [channelId]: { ...cur, messages, ...indexFields(buildMessageIndex(messages)), hasMore: hasMore || merged.length > messages.length, loading: false, error: null, change: { kind: 'structural' } },
                },
              };
            }
            const messages = capHistory(res.data.data.messages);
            return {
              channels: {
                ...st.channels,
                [channelId]: { messages, ...indexFields(buildMessageIndex(messages)), hasMore: res.data.data.hasMore || messages.length < res.data.data.messages.length, loading: false, error: null, loaded: true, change: { kind: 'reset' } },
              },
            };
          });
        } catch (err) {
          if (!s.gate.isLatest(seq) || !lifecycle.has(channelId)) return;
          console.error('[Channel] Failed to fetch messages', err);
          // #482：error 态供页面区分「加载失败（可重试）/ 真空频道」；已加载消息不清空
          set(st => {
            const cur = st.channels[channelId] ?? freshSlice();
            return {
              channels: {
                ...st.channels,
                [channelId]: { ...cur, loading: false, error: err instanceof Error ? err.message : String(err) },
              },
            };
          });
        }
      },
    );
  },

  ensureFresh: async (opts) => {
    void opts; // 消息面原本即无 TTL；统一入口只收窄到活跃键。
    await Promise.all(lifecycle.activeKeys().map(id => get().fetchMessages(id)));
  },

  subscribeChannel: (channelId) => lifecycle.acquire(channelId),

  loadMore: async (channelId) => {
    lifecycle.touch(channelId);
    const slice = get().channels[channelId];
    if (!slice?.hasMore) return false;
    // #486：游标取最老非 pending 消息——pending 是本地乐观 id，服务端不存在，作锚点会翻出空页
    const oldest = slice.messages.find(m => !m.pending);
    const before = slice.beforeCursor ?? oldest?.id;
    if (!before) return false;
    const requestKey = `${channelId}:${before}`;
    const existing = loadMoreInflight.get(requestKey);
    if (existing) return existing;
    const incarnation = lifecycle.incarnation(channelId);
    const gate = loadMoreGateOf(channelId);
    const seq = gate.nextSeq();
    const request = (async () => {
      try {
        // cap 后 beforeCursor 独立前进，避免最老驻留对象不变导致重复页。
        const res = await channelApi.listMessages(channelId, { before });
        const older = res.data.data.messages;
        set(st => {
          const cur = st.channels[channelId];
          if (!cur || !gate.isLatest(seq) || lifecycle.incarnation(channelId) !== incarnation) return st;
          const overflow = Math.max(0, older.length + cur.messages.length - CHANNEL_MESSAGE_HISTORY_CAP);
          // 新页真实进入窗口；被跳过的中间段以 degraded 间隙标记，水合可按后续锚点恢复。
          const retained = overflow > 0 ? cur.messages.slice(overflow - 1) : cur.messages;
          const messages = [...older, ...retained];
          if (overflow > 0 && retained.length > 1) {
            messages[older.length] = degradeMessage(retained[0]);
          } else if (overflow > 0 && older.length > 0) {
            messages[older.length - 1] = degradeMessage(older[older.length - 1]);
          }
          if (overflow > 0 && retained.length === 0 && cur.messages.length > 0) {
            // before 排他且 older 已覆盖整个旧窗口时，保留一个最新端恢复锚；总量至多 CAP+1。
            messages.push(cur.messages[cur.messages.length - 1]);
          }
          return { channels: { ...st.channels, [channelId]: { ...cur, messages, ...indexFields(buildMessageIndex(messages)), hasMore: res.data.data.hasMore, beforeCursor: older[0]?.id ?? before, change: { kind: 'structural' } } } };
        });
        return older.length > 0;
      } catch (err) {
        console.error('[Channel] Failed to load more', err);
        return false;
      }
    })();
    loadMoreInflight.set(requestKey, request);
    try {
      return await request;
    } finally {
      if (loadMoreInflight.get(requestKey) === request) loadMoreInflight.delete(requestKey);
    }
  },

  applyMessageSent: (channelId, message) => {
    lifecycle.touch(channelId);
    // #520 测量②：回执渲染计时起点——仅 agent 新消息记（人类消息不是回执）；
    // 已在列表的 SSE 回声不记（其渲染由 REST 替换完成，非本次到达）
    const cur = get().channels[channelId];
    if (message.authorType === 'agent' && !cur?.byId?.has(message.id)) markReceiptArrived(message.id);
    set(st => {
      const slice = st.channels[channelId] ?? freshSlice();
      const index = indexOf(slice);
      if (index.byId.has(message.id)) return st;
      const previous = slice.messages[slice.messages.length - 1];
      const isTail = !previous || new Date(previous.createdAt).getTime() <= new Date(message.createdAt).getTime();
      const inserted = isTail ? [...slice.messages, message] : insertMessage(slice.messages, message);
      const window = capWithRecovery(slice, inserted);
      const messages = window.messages;
      if (isTail && messages.length === inserted.length) {
        upsertIndex(index, message, messages.length - 1);
        return { channels: { ...st.channels, [channelId]: { ...slice, ...window, agentWorkUnitIds: index.agentWorkUnitIds, change: { kind: 'append', id: message.id } } } };
      }
      return { channels: { ...st.channels, [channelId]: { ...slice, ...window, ...indexFields(buildMessageIndex(messages)), change: { kind: 'structural' } } } };
    });
  },

  applyMessageUpdated: (channelId, data) => {
    lifecycle.touch(channelId);
    set(st => {
      const cur = st.channels[channelId];
      if (!cur) return st;
      const targetId = data.message?.id ?? data.messageId;
      const index = cur ? indexOf(cur) : null;
      const position = targetId && index ? index.itemIndex.get(targetId) : undefined;
      if (!targetId || !index || position === undefined) return st;
      const previous = index.byId.get(targetId)!;
      let next = previous;
      if (data.message) {
        // #315：全量 message 本体的 meta 为后端合并后真值，消除增量 meta 整体替换丢旧 key 的分叉
        next = data.message as ChannelMessage;
      } else if (data.messageId) {
        next = {
          ...previous,
          meta: (data.meta as Record<string, unknown> | undefined) ?? previous.meta,
          ...(data.content != null ? { content: data.content, degraded: false } : {}),
        };
      }
      const messages = [...cur.messages];
      messages[position] = next;
      const structural = previous.replyToId !== next.replyToId || previous.workUnitId !== next.workUnitId
        || previous.authorType !== next.authorType || previous.createdAt !== next.createdAt;
      if (structural) {
        return { channels: { ...st.channels, [channelId]: { ...cur, messages, ...indexFields(buildMessageIndex(messages)), change: { kind: 'structural' } } } };
      }
      upsertIndex(index, next, position, previous);
      return { channels: { ...st.channels, [channelId]: { ...cur, messages, change: { kind: 'update', id: targetId } } } };
    });
  },

  sendMessage: async (channelId, content, replyToId, files, intent) => {
    lifecycle.touch(channelId);
    if (!content.trim()) return null;
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingMsg: ChannelMessage = {
      id: pendingId,
      channelId,
      authorType: 'human',
      agentName: null,
      content,
      replyToId: replyToId ?? null,
      workUnitId: null,
      meta: {},
      createdAt: new Date().toISOString(),
      pending: true,
    };
    set(st => {
      const cur = st.channels[channelId] ?? freshSlice();
      const window = capWithRecovery(cur, insertMessage(cur.messages, pendingMsg));
      return { channels: { ...st.channels, [channelId]: { ...cur, ...window, ...indexFields(buildMessageIndex(window.messages)), change: { kind: 'structural' } } } };
    });
    try {
      // #632：intent 缺省保旧四参调用形态（对齐 files 的 arity 口径；channelApi 侧 undefined 不序列化）
      const res = intent
        ? await channelApi.sendMessage(channelId, content, replyToId, files, intent)
        : await channelApi.sendMessage(channelId, content, replyToId, files);
      const msg = res.data.data;
      // 服务端本体原位替换（SSE 回声先到则已按 id 插入，替换同样收敛不重复）
      set(st => {
        const cur = st.channels[channelId];
        if (!cur || !lifecycle.has(channelId)) return st;
        const window = capWithRecovery(cur, insertMessage(cur.messages.filter(m => m.id !== pendingId), msg));
        return {
          channels: {
            ...st.channels,
            [channelId]: { ...cur, ...window, ...indexFields(buildMessageIndex(window.messages)), change: { kind: 'structural' } },
          },
        };
      });
      return msg;
    } catch (err) {
      set(st => {
        const cur = st.channels[channelId];
        if (!cur) return st;
        const window = capWithRecovery(cur, cur.messages.filter(m => m.id !== pendingId));
        return { channels: { ...st.channels, [channelId]: { ...cur, ...window, ...indexFields(buildMessageIndex(window.messages)), change: { kind: 'structural' } } } };
      });
      throw err;
    }
  },

  syncPruning: (channelId, anchorMid, opts) => {
    lifecycle.touch(channelId);
    const slice = get().channels[channelId];
    if (!slice) return;
    const plan = planPrune(slice.messages, anchorMid, {
      keepRecent: PRUNE_KEEP_RECENT,
      degradeDistance: PRUNE_DEGRADE_DISTANCE,
      hydrateDistance: PRUNE_HYDRATE_DISTANCE,
      ...opts,
    });
    if (plan.degradeIds.length > 0) {
      const ids = new Set(plan.degradeIds);
      set(st => {
        const cur = st.channels[channelId];
        if (!cur) return st;
        const messages = cur.messages.map(m => (ids.has(m.id) ? degradeMessage(m) : m));
        return { channels: { ...st.channels, [channelId]: { ...cur, messages, ...indexFields(buildMessageIndex(messages)), change: { kind: 'structural' } } } };
      });
    }
    if (plan.hydrateBefore) scheduleHydration(channelId, plan.hydrateBefore);
  },

  __resetForTests: () => {
    lifecycle.dispose();
    book.clear();
    loadMoreGates.clear();
    loadMoreInflight.clear();
    hydrationGates.clear();
    for (const h of hydration.values()) {
      if (h.timer) clearTimeout(h.timer);
    }
    hydration.clear();
    set({ channels: {} });
  },
}));

/** #493：「等待 agent」状态条的派生判定（自 ChannelDetailPage 迁出；输入/输出不变，
 *  数据来自 store 切片——照 needInputViewOf / wuIdleOf 旁挂纯函数先例） */
export function agentAnsweredOf(
  messages: ChannelMessage[],
  awaitingAgent: { wuId: string; since: number } | null,
): boolean {
  return !!awaitingAgent && messages.some(m =>
    m.authorType === 'agent' && m.workUnitId === awaitingAgent.wuId &&
    new Date(m.createdAt).getTime() >= awaitingAgent.since
  );
}
