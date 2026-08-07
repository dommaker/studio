// Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询
import { useState, useEffect, useCallback } from 'react';
import { channelApi, type ChannelMessage } from '../api/channel';
import { useWebSocketContext } from '../api/websocketHooks';

export function useChannelMessages(channelId: string | undefined) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const { onEvent, status } = useWebSocketContext();

  const fetchMessages = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await channelApi.listMessages(channelId);
      setMessages(res.data.data);
      setHasMore(res.data.hasMore);
    } catch (err) {
      console.error('[Channel] Failed to fetch messages', err);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  // Initial load
  useEffect(() => {
    if (!channelId) return;
    setLoading(true);
    fetchMessages();
  }, [channelId, fetchMessages]);

  // B2: SSE 实时推送替代轮询
  useEffect(() => {
    if (!channelId) return;
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as { channelId?: string; message?: ChannelMessage };
        if (data?.channelId === channelId && data?.message) {
          setMessages(prev => {
            // 去重：SSE 事件可能比自己发送的乐观更新晚到
            if (prev.some(m => m.id === data.message!.id)) return prev;
            return [...prev, data.message];
          });
        }
      } else if (msg.event_type === 'channel.message_updated') {
        const data = msg.data as { channelId?: string; messageId?: string; meta?: string; content?: string };
        if (data?.channelId === channelId && data?.messageId) {
          setMessages(prev => prev.map(m =>
            m.id === data.messageId
              ? { ...m, meta: data.meta ?? m.meta, content: (data.content ?? m.content) as string }
              : m
          ));
        }
      }
    });
    return unsub;
  }, [channelId, onEvent]);

  // 降级：SSE 断开时每 10s 轮询兜底
  useEffect(() => {
    if (status === 'connected' || !channelId) return;
    const poll = setInterval(fetchMessages, 10000);
    return () => clearInterval(poll);
  }, [channelId, fetchMessages, status]);

  const sendMessage = useCallback(async (content: string, replyToId?: string) => {
    if (!channelId || !content.trim()) return null;
    const res = await channelApi.sendMessage(channelId, content, replyToId);
    const msg = res.data.data;
    setMessages(prev => [...prev, msg]);
    return msg;
  }, [channelId]);

  const loadMore = useCallback(async () => {
    if (!channelId || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;
    try {
      const res = await channelApi.listMessages(channelId, { before: oldest.createdAt });
      const older = res.data.data;
      setMessages(prev => [...older, ...prev]);
      setHasMore(res.data.hasMore);
    } catch (err) {
      console.error('[Channel] Failed to load more', err);
    }
  }, [channelId, hasMore, messages]);

  return { messages, loading, hasMore, sendMessage, loadMore, refresh: fetchMessages };
}
