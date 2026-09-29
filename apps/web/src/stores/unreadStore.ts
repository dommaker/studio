// 频道未读面共享 store（#413）——自 useChannelList hook 实例私有 state 提升：
// ① 断点跨越（<768 内联 ChannelRail 卸载、SidebarNew 挂另一实例）计数不丢；
// ② 「正在看」语义：activeChannelId 由频道页（ChannelDetailPage）写入，active 频道不涨未读，
//    进频道即清零（打开即读，对齐 notificationStore.markChannelRead 先例）。
// SSE 增量接线在 useUnreadStoreSync（引用计数单例），事件处理逻辑唯一一份在本 store action。
// 2026-09-25 断点修复：lastSeenAt 簿记 + resyncOnReconnect——断线期间错过的 message_sent
// 无事件可达，SSE 重连后拉各频道最新一页补底数（窗口外 >50 条/频道按下界口径不追全量，
// 对齐 #525 total 下界先例）；同一消息经 resync/SSE 双通道到达靠 lastSeenAt 幂等不重复计。
import { create } from 'zustand';
import { channelApi, type ChannelMessage } from '../api/channel';
import { fanOut } from '../utils/fanOut';

/** 重连补底数每频道拉取页大小（窗口外按下界口径） */
const RESYNC_PAGE_LIMIT = 50;

interface UnreadState {
  unreadCounts: Record<string, number>;
  /** 正在查看的频道（频道页挂载写入、卸载清空）；null = 不在任何频道页 */
  activeChannelId: string | null;
  /** channelId → 已确认见到的最新消息时间（ms）：SSE 事件（消息 createdAt）推进 /
   *  进频道即读与清零记此刻 / resync 推进到页内最大 createdAt */
  lastSeenAt: Record<string, number>;
  /** SSE channel.message_sent：非人类消息 +1；active 频道不计。
   *  at = 消息 createdAt(ms)：提供时 ≤ lastSeenAt 视为已入账（resync 幂等），缺省（Date.now）恒计 */
  applyMessageSent: (channelId: string, authorType?: string, at?: number) => void;
  /** 频道页挂载/路由切换写入；进入即清零该频道计数（打开即读） */
  setActiveChannel: (channelId: string | null) => void;
  clearUnread: (channelId: string) => void;
  /** SSE 断线重连补底数：对 lastSeenAt 有簿记的频道并行拉最新一页，
   *  数 lastSeenAt 之后的非人类消息并入计数；单频道拉取失败保留现状等下次重连 */
  resyncOnReconnect: () => Promise<void>;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  unreadCounts: {},
  activeChannelId: null,
  lastSeenAt: {},

  applyMessageSent: (channelId, authorType, at) => {
    set(state => {
      const prev = state.lastSeenAt[channelId] ?? 0;
      // at 提供（SSE 带消息 createdAt）且不晚于簿记 → resync/重复事件已覆盖，幂等跳过；
      // at 缺省走 Date.now 恒计（保留旧调用语义）
      const seen = at ?? Date.now();
      const alreadyCounted = at !== undefined && seen <= prev;
      const lastSeenAt = seen > prev ? { ...state.lastSeenAt, [channelId]: seen } : state.lastSeenAt;
      if (authorType === 'human' || state.activeChannelId === channelId || alreadyCounted) {
        return { lastSeenAt };
      }
      return {
        lastSeenAt,
        unreadCounts: { ...state.unreadCounts, [channelId]: (state.unreadCounts[channelId] || 0) + 1 },
      };
    });
  },

  setActiveChannel: (channelId) => {
    set(state => {
      // 进频道即读：簿记推进到此刻（首拉历史与在途 SSE 均早于此刻，resync 不翻旧账）
      const lastSeenAt = channelId
        ? { ...state.lastSeenAt, [channelId]: Date.now() }
        : state.lastSeenAt;
      if (!channelId || !state.unreadCounts[channelId]) {
        return { activeChannelId: channelId, lastSeenAt };
      }
      const unreadCounts = { ...state.unreadCounts };
      delete unreadCounts[channelId];
      return { activeChannelId: channelId, lastSeenAt, unreadCounts };
    });
  },

  clearUnread: (channelId) => {
    set(state => {
      const lastSeenAt = { ...state.lastSeenAt, [channelId]: Date.now() };
      if (!state.unreadCounts[channelId]) return { lastSeenAt };
      const unreadCounts = { ...state.unreadCounts };
      delete unreadCounts[channelId];
      return { lastSeenAt, unreadCounts };
    });
  },

  resyncOnReconnect: async () => {
    const channelIds = Object.keys(get().lastSeenAt);
    if (channelIds.length === 0) return;
    const results = await fanOut(channelIds, (id) =>
      channelApi.listMessages(id, { limit: RESYNC_PAGE_LIMIT }).then(r => r.data?.data ?? []));
    set(state => {
      const unreadCounts = { ...state.unreadCounts };
      const lastSeenAt = { ...state.lastSeenAt };
      for (let i = 0; i < channelIds.length; i++) {
        const id = channelIds[i];
        const entry = results[i];
        if (entry.ok !== true) continue; // 该频道拉取失败：保留现状，下次重连再补
        const since = state.lastSeenAt[id] ?? 0;
        let maxSeen = since;
        let add = 0;
        for (const m of entry.value as ChannelMessage[]) {
          const t = Date.parse(m.createdAt);
          if (Number.isNaN(t)) continue;
          if (t > maxSeen) maxSeen = t;
          if (t > since && m.authorType !== 'human') add++;
        }
        lastSeenAt[id] = maxSeen;
        if (add > 0 && state.activeChannelId !== id) {
          unreadCounts[id] = (unreadCounts[id] || 0) + add;
        }
      }
      return { unreadCounts, lastSeenAt };
    });
  },
}));
