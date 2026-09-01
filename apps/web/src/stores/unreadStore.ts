// 频道未读面共享 store（#413）——自 useChannelList hook 实例私有 state 提升：
// ① 断点跨越（<768 内联 ChannelRail 卸载、SidebarNew 挂另一实例）计数不丢；
// ② 「正在看」语义：activeChannelId 由频道页（ChannelDetailPage）写入，active 频道不涨未读，
//    进频道即清零（打开即读，对齐 notificationStore.markChannelRead 先例）。
// SSE 增量接线在 useUnreadStoreSync（引用计数单例），事件处理逻辑唯一一份在本 store action。
import { create } from 'zustand';

interface UnreadState {
  unreadCounts: Record<string, number>;
  /** 正在查看的频道（频道页挂载写入、卸载清空）；null = 不在任何频道页 */
  activeChannelId: string | null;
  /** SSE channel.message_sent：非人类消息 +1；active 频道不计 */
  applyMessageSent: (channelId: string, authorType?: string) => void;
  /** 频道页挂载/路由切换写入；进入即清零该频道计数（打开即读） */
  setActiveChannel: (channelId: string | null) => void;
  clearUnread: (channelId: string) => void;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  unreadCounts: {},
  activeChannelId: null,

  applyMessageSent: (channelId, authorType) => {
    if (authorType === 'human') return;
    if (get().activeChannelId === channelId) return;
    set(state => ({
      unreadCounts: { ...state.unreadCounts, [channelId]: (state.unreadCounts[channelId] || 0) + 1 },
    }));
  },

  setActiveChannel: (channelId) => {
    set(state => {
      if (!channelId || !state.unreadCounts[channelId]) {
        return { activeChannelId: channelId };
      }
      const unreadCounts = { ...state.unreadCounts };
      delete unreadCounts[channelId];
      return { activeChannelId: channelId, unreadCounts };
    });
  },

  clearUnread: (channelId) => {
    set(state => {
      if (!state.unreadCounts[channelId]) return state;
      const unreadCounts = { ...state.unreadCounts };
      delete unreadCounts[channelId];
      return { unreadCounts };
    });
  },
}));
