// 频道列表数据 hook —— ChannelHomeRedirect（#393）与 Mission Control 左栏 ChannelRail 共用
// 数据来源与 B2-011 未读 SSE 逻辑单源化，避免两处实现漂移。
// #346：channels 切片上移 rosterStore（TTL 缓存 + 路由切换零重拉），本 hook 只保留
// 未读计数（SSE channel.message_sent）与创建频道（写回 store）；loading 只看频道切片自身
// （channelsLoadedOnce），不被 Admin-only 的 agents 慢请求/403 拖住。
import { useState, useEffect, useCallback } from 'react';
import { channelApi, type Channel } from '../api/channel';
import { useWebSocketContext } from '../api/websocketHooks';
import { useRosterStore } from '../stores/rosterStore';

export interface ChannelListItem {
  id: string;
  name: string;
  type: string;
  createdAt?: string;
  members?: string;
  defaultWorkspaceId?: string | null;
}

export interface CreateChannelInput {
  name: string;
  type: string;
  /** 初始 Agent 名（逗号/换行拆分后的数组） */
  agents: string[];
  /** #272：可选默认工程（本地 repo 路径，创建即绑定，可留空） */
  defaultPath?: string;
}

export function useChannelList() {
  const channels = useRosterStore((s) => s.channels);
  const channelsLoadedOnce = useRosterStore((s) => s.channelsLoadedOnce);
  // B2-011: per-channel unread counters
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const { onEvent } = useWebSocketContext();

  // #346：TTL 门禁拉取（频道切片）。实时面（SSE 状态事件/兜底轮询）由使用方页面挂
  // useRosterStoreSync 统一接线——本 hook 可能与页面同时挂载，在此重复挂会双订阅/双计时器
  useEffect(() => {
    void useRosterStore.getState().ensureFresh();
  }, []);

  // B2-011: SSE track unread messages per channel
  useEffect(() => {
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as { channelId?: string; message?: { authorType?: string } };
        if (data?.channelId && data?.message?.authorType !== 'human') {
          setUnreadCounts(prev => ({
            ...prev,
            [data.channelId]: (prev[data.channelId] || 0) + 1,
          }));
        }
      }
    });
    return unsub;
  }, [onEvent]);

  const clearUnread = useCallback((channelId: string) => {
    setUnreadCounts(prev => { const next = { ...prev }; delete next[channelId]; return next; });
  }, []);

  // B2-007: Create new channel (with optional initial agents)
  const createChannel = useCallback(async (input: CreateChannelInput): Promise<ChannelListItem> => {
    const agents = input.agents.map(name => ({ name }));
    const res = await channelApi.create({
      name: input.name,
      type: input.type,
      ...(agents.length > 0 ? { agents } : {}),
      ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
    });
    const ch = res.data.data as Channel;
    useRosterStore.getState().appendChannel(ch);
    return ch;
  }, []);

  // TTL 内重挂载：channels 已在缓存里，不再闪「加载中」（#346 验收：路由切换 TTL 内零重拉）；
  // 频道切片失败（非 403）也置 channelsLoadedOnce → loading 终结为空列表（对齐旧 catch(() => {}) 行为）
  return { channels, loading: !channelsLoadedOnce, unreadCounts, clearUnread, createChannel };
}
