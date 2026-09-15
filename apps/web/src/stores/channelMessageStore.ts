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
import { channelApi, type ChannelMessage, type FileRef } from '../api/channel';
import { insertMessage, mergePage } from '../utils/messageList';
import {
  degradeMessage, planPrune,
  PRUNE_KEEP_RECENT, PRUNE_DEGRADE_DISTANCE, PRUNE_HYDRATE_DISTANCE, PRUNE_HYDRATE_PAGE_LIMIT,
  type PruneOptions,
} from '../utils/messagePruning';
import { markReceiptArrived } from '../utils/clientPerf';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';

/** per-channelId 消息切片（缺键 = 从未加载；消费方按「首拉进行中」渲染） */
export interface ChannelMessagesSlice {
  /** 恒按 createdAt 升序（下游 groupIntoThreads 单遍归组不变式） */
  messages: ChannelMessage[];
  /** prepend 方向是否还有更早历史 */
  hasMore: boolean;
  loading: boolean;
  /** #482：首拉/兜底轮询失败暴露 error 态（页面据此区分加载失败/真空频道） */
  error: string | null;
  /** 首拉已完成（旧 loadedChannelRef 的 store 形态）——同频道 refetch 走合并，否则替换 */
  loaded: boolean;
}

/** message_updated 负载（全量本体优先；旧形状回退增量 patch，见 #315 ADR 2026-08-24 D1/D2） */
export interface MessageUpdatedPayload {
  messageId?: string;
  meta?: string | Record<string, unknown>;
  content?: string;
  message?: ChannelMessage;
}

interface ChannelMessageState {
  channels: Record<string, ChannelMessagesSlice | undefined>;

  /** 频道切换复位：置 loading、清 error、保留已有消息（旧渲染期语义的 store 形态） */
  beginLoad: (channelId: string) => void;
  /** 首拉 / refetch（兜底轮询、重连、手动 refresh 共用）：loaded → 合并，否则替换 */
  fetchMessages: (channelId: string) => Promise<void>;
  /** #290：返回是否真实前插（供调用方在失败/无更多时清理行锚点，防视口乱跳） */
  loadMore: (channelId: string) => Promise<boolean>;
  /** SSE channel.message_sent：有序插入 + id 去重（含 #520 回执计时起点） */
  applyMessageSent: (channelId: string, message: ChannelMessage) => void;
  /** SSE channel.message_updated：全量本体原位替换 / legacy 增量 patch */
  applyMessageUpdated: (channelId: string, data: MessageUpdatedPayload) => void;
  /** #486 乐观回显：成功返回服务端本体；失败回滚 pending + 上抛；空内容返回 null */
  sendMessage: (channelId: string, content: string, replyToId?: string, files?: FileRef[]) => Promise<ChannelMessage | null>;
  /** #326：渲染侧在首个可见消息变化时调用（anchorMid = 首个可见消息 id，null = 无可锚行不动作） */
  syncPruning: (channelId: string, anchorMid: string | null, opts?: Partial<PruneOptions>) => void;
  /** 测试隔离：清数据面 + 纪律簿记 + 水合计时器（模块级 gate/timer 不在 zustand 内） */
  __resetForTests: () => void;
}

/** 缺省切片：loading=true（首拉进行中语义——SSE 先于首拉到达建切片时不同步闪空态） */
function freshSlice(): ChannelMessagesSlice {
  return { messages: [], hasMore: false, loading: true, error: null, loaded: false };
}

// 纪律簿记按 channelId 模块级持有：数据在 zustand（消费方订阅），门禁状态不进响应式树
const book = new Map<string, { gate: FetchGate; state: FetchGateState }>();

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
    void (async () => {
      try {
        const res = await channelApi.listMessages(channelId, { before, limit: PRUNE_HYDRATE_PAGE_LIMIT });
        // 骨架原位复活（按 id 归并）；hasMore 不动——本路径与 prepend 方向无关
        useChannelMessageStore.setState(st => {
          const cur = st.channels[channelId];
          if (!cur) return st;
          return { channels: { ...st.channels, [channelId]: { ...cur, messages: mergePage(cur.messages, res.data.data) } } };
        });
      } catch (err) {
        console.error('[Channel] Failed to hydrate messages', err);
      } finally {
        h.inFlight = false;
      }
    })();
  }, 200);
}

export const useChannelMessageStore = create<ChannelMessageState>((set, get) => ({
  channels: {},

  beginLoad: (channelId) => {
    set(st => {
      const cur = st.channels[channelId] ?? freshSlice();
      return { channels: { ...st.channels, [channelId]: { ...cur, loading: true, error: null } } };
    });
  },

  fetchMessages: (channelId) => {
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
          if (!s.gate.isLatest(seq)) return;
          set(st => {
            const cur = st.channels[channelId];
            if (cur?.loaded) {
              // 合并路径：prepend 的历史页不丢；hasMore 仅当本地最老消息落在最新一页内
              // （未 prepend 出页外）才以响应为准
              const oldest = cur.messages[0];
              const hasMore = !oldest || res.data.data.some(m => m.id === oldest.id)
                ? res.data.hasMore
                : cur.hasMore;
              return {
                channels: {
                  ...st.channels,
                  [channelId]: { ...cur, messages: mergePage(cur.messages, res.data.data), hasMore, loading: false, error: null },
                },
              };
            }
            return {
              channels: {
                ...st.channels,
                [channelId]: { messages: res.data.data, hasMore: res.data.hasMore, loading: false, error: null, loaded: true },
              },
            };
          });
        } catch (err) {
          if (!s.gate.isLatest(seq)) return;
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

  loadMore: async (channelId) => {
    const slice = get().channels[channelId];
    if (!slice?.hasMore) return false;
    // #486：游标取最老非 pending 消息——pending 是本地乐观 id，服务端不存在，作锚点会翻出空页
    const oldest = slice.messages.find(m => !m.pending);
    if (!oldest) return false;
    try {
      // #319：游标 = 锚点消息 id（原 createdAt 时间戳同毫秒撞车会漏/重）
      const res = await channelApi.listMessages(channelId, { before: oldest.id });
      const older = res.data.data;
      set(st => {
        const cur = st.channels[channelId];
        if (!cur) return st;
        return { channels: { ...st.channels, [channelId]: { ...cur, messages: [...older, ...cur.messages], hasMore: res.data.hasMore } } };
      });
      return older.length > 0;
    } catch (err) {
      console.error('[Channel] Failed to load more', err);
      return false;
    }
  },

  applyMessageSent: (channelId, message) => {
    // #520 测量②：回执渲染计时起点——仅 agent 新消息记（人类消息不是回执）；
    // 已在列表的 SSE 回声不记（其渲染由 REST 替换完成，非本次到达）
    const cur = get().channels[channelId];
    if (message.authorType === 'agent' && !cur?.messages.some(m => m.id === message.id)) {
      markReceiptArrived(message.id);
    }
    set(st => {
      const slice = st.channels[channelId] ?? freshSlice();
      return { channels: { ...st.channels, [channelId]: { ...slice, messages: insertMessage(slice.messages, message) } } };
    });
  },

  applyMessageUpdated: (channelId, data) => {
    set(st => {
      const cur = st.channels[channelId];
      if (!cur) return st;
      let messages = cur.messages;
      if (data.message) {
        // #315：全量 message 本体的 meta 为后端合并后真值，消除增量 meta 整体替换丢旧 key 的分叉
        const full = data.message;
        messages = cur.messages.map(m => (m.id === full.id ? full : m));
      } else if (data.messageId) {
        messages = cur.messages.map(m =>
          m.id === data.messageId
            // #326：patch 带 content = 拿到本体即复活清标记（「拿到全量本体即复活」唯一规则）；
            // 仅 meta 的 patch 骨架不假复活（空正文不应渲染为全量行）
            ? {
                ...m,
                meta: data.meta ?? m.meta,
                ...(data.content != null ? { content: data.content, degraded: false } : {}),
              }
            : m
        );
      }
      return { channels: { ...st.channels, [channelId]: { ...cur, messages } } };
    });
  },

  sendMessage: async (channelId, content, replyToId, files) => {
    if (!content.trim()) return null;
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingMsg: ChannelMessage = {
      id: pendingId,
      channelId,
      authorType: 'human',
      content,
      replyToId: replyToId ?? null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    set(st => {
      const cur = st.channels[channelId] ?? freshSlice();
      return { channels: { ...st.channels, [channelId]: { ...cur, messages: insertMessage(cur.messages, pendingMsg) } } };
    });
    try {
      const res = await channelApi.sendMessage(channelId, content, replyToId, files);
      const msg = res.data.data;
      // 服务端本体原位替换（SSE 回声先到则已按 id 插入，替换同样收敛不重复）
      set(st => {
        const cur = st.channels[channelId];
        if (!cur) return st;
        return {
          channels: {
            ...st.channels,
            [channelId]: { ...cur, messages: insertMessage(cur.messages.filter(m => m.id !== pendingId), msg) },
          },
        };
      });
      return msg;
    } catch (err) {
      set(st => {
        const cur = st.channels[channelId];
        if (!cur) return st;
        return { channels: { ...st.channels, [channelId]: { ...cur, messages: cur.messages.filter(m => m.id !== pendingId) } } };
      });
      throw err;
    }
  },

  syncPruning: (channelId, anchorMid, opts) => {
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
        return { channels: { ...st.channels, [channelId]: { ...cur, messages: cur.messages.map(m => (ids.has(m.id) ? degradeMessage(m) : m)) } } };
      });
    }
    if (plan.hydrateBefore) scheduleHydration(channelId, plan.hydrateBefore);
  },

  __resetForTests: () => {
    book.clear();
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
