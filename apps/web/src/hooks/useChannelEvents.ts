// Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询
import { useState, useEffect, useCallback } from 'react';
import { channelApi, type ChannelMessage, type FileRef } from '../api/channel';
import { useWebSocketContext } from '../api/websocketHooks';

/** #287（清单 P2 #19）：增量到达按 createdAt 升序归位 + id 去重。
 *  下游 groupIntoThreads 单遍归组要求 anchor 先于 reply 出现；一律 push 尾部会让
 *  乱序/孤儿到达的线程回复滞留主流（走查 F17：同一消息刷新前后两种位置）。
 *  有序插入后，任意到达路径下的顺序与刷新全量列表一致，孤儿回复在 anchor 到达时归并。 */
function insertMessage(prev: ChannelMessage[], msg: ChannelMessage): ChannelMessage[] {
  if (prev.some(m => m.id === msg.id)) return prev;
  const t = new Date(msg.createdAt).getTime();
  let idx = prev.length;
  while (idx > 0 && new Date(prev[idx - 1].createdAt).getTime() > t) idx--;
  return [...prev.slice(0, idx), msg, ...prev.slice(idx)];
}

export function useChannelMessages(channelId: string | undefined) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  // 初值覆盖挂载首拉；channelId undefined→defined 的上升沿由下方渲染期分支补齐
  const [loading, setLoading] = useState(!!channelId);
  const [hasMore, setHasMore] = useState(false);
  const { onEvent, status } = useWebSocketContext();

  // 切换频道时渲染期置 loading（替代原 effect 内同步置位，早一帧）；
  // 旧频道消息保留到新数据到达，不做清空
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (prevChannelId !== channelId) {
    setPrevChannelId(channelId);
    if (channelId) setLoading(true);
  }

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

  // Initial load（微任务触发：编译器对含 catch 的多语句 async 函数保守告警，
  // 微任务推迟一拍，时序与直接调用逐帧等价；loading 置位由上方渲染期分支负责）
  useEffect(() => {
    if (!channelId) return;
    void Promise.resolve().then(fetchMessages);
  }, [channelId, fetchMessages]);

  // B2: SSE 实时推送替代轮询
  useEffect(() => {
    if (!channelId) return;
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as { channelId?: string; message?: ChannelMessage };
        if (data?.channelId === channelId && data?.message) {
          setMessages(prev => insertMessage(prev, data.message!));
        }
      } else if (msg.event_type === 'channel.message_updated') {
        const data = msg.data as { channelId?: string; messageId?: string; meta?: string | Record<string, unknown>; content?: string };
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

  const sendMessage = useCallback(async (content: string, replyToId?: string, files?: FileRef[]) => {
    if (!channelId || !content.trim()) return null;
    const res = await channelApi.sendMessage(channelId, content, replyToId, files);
    const msg = res.data.data;
    setMessages(prev => insertMessage(prev, msg));
    return msg;
  }, [channelId]);

  // #290（清单 #22）：返回是否真实前插（供调用方在失败/无更多时清理行锚点，防视口乱跳）
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!channelId || !hasMore) return false;
    const oldest = messages[0];
    if (!oldest) return false;
    try {
      const res = await channelApi.listMessages(channelId, { before: oldest.createdAt });
      const older = res.data.data;
      setMessages(prev => [...older, ...prev]);
      setHasMore(res.data.hasMore);
      return older.length > 0;
    } catch (err) {
      console.error('[Channel] Failed to load more', err);
      return false;
    }
  }, [channelId, hasMore, messages]);

  return { messages, loading, hasMore, sendMessage, loadMore, refresh: fetchMessages };
}
