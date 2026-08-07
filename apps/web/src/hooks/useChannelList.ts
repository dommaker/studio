// 频道列表数据 hook —— ChannelListPage 与 Mission Control 左栏 ChannelRail 共用
// 数据来源与 B2-011 未读 SSE 逻辑单源化，避免两处实现漂移
import { useState, useEffect, useCallback } from 'react';
import { channelApi } from '../api/channel';
import { useWebSocketContext } from '../api/websocket';

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
}

export function useChannelList() {
  const [channels, setChannels] = useState<ChannelListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // B2-011: per-channel unread counters
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const { onEvent } = useWebSocketContext();

  useEffect(() => {
    channelApi.list()
      .then(r => setChannels(r.data.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
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
    });
    const ch = res.data.data as ChannelListItem;
    setChannels(prev => [...prev, ch]);
    return ch;
  }, []);

  return { channels, loading, unreadCounts, clearUnread, createChannel };
}
