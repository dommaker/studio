// Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询
// #313：首拉 / SSE 断开 10s 兜底 / visibility 门禁统一收敛到 useGatedPoll
import { useState, useEffect, useCallback, useRef } from 'react';
import { channelApi, type ChannelMessage, type FileRef } from '../api/channel';
import { useWebSocketContext } from '../api/websocketHooks';
import { useGatedPoll } from './useGatedPoll';
import { degradeMessage, planPrune, PRUNE_KEEP_RECENT, PRUNE_DEGRADE_DISTANCE, PRUNE_HYDRATE_DISTANCE, PRUNE_HYDRATE_PAGE_LIMIT, type PruneOptions } from '../utils/messagePruning';

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

/** #328：refetch 合并——最新一页按 id 归并进现有列表：已存在的以服务端版本刷新，
 *  新消息按 createdAt 有序插入，已 prepend 的历史页原样保留。 */
function mergePage(prev: ChannelMessage[], page: ChannelMessage[]): ChannelMessage[] {
  const fresh = new Map(page.map(m => [m.id, m]));
  const prevIds = new Set(prev.map(m => m.id));
  let next = prev.map(m => fresh.get(m.id) ?? m);
  for (const m of page) {
    if (!prevIds.has(m.id)) next = insertMessage(next, m);
  }
  return next;
}

export interface UseChannelMessagesOptions {
  /** #326：降级/水合阈值覆盖（测试用小参数；缺省 = messagePruning 常量） */
  prune?: Partial<PruneOptions>;
}

export function useChannelMessages(channelId: string | undefined, options?: UseChannelMessagesOptions) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  // 初值覆盖挂载首拉；channelId undefined→defined 的上升沿由下方渲染期分支补齐
  const [loading, setLoading] = useState(!!channelId);
  const [hasMore, setHasMore] = useState(false);
  const { onEvent } = useWebSocketContext();

  // 切换频道时渲染期置 loading（替代原 effect 内同步置位，早一帧）；
  // 旧频道消息保留到新数据到达，不做清空
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (prevChannelId !== channelId) {
    setPrevChannelId(channelId);
    if (channelId) setLoading(true);
  }

  // #328：记录当前已完成首拉的频道——同频道 refetch 走合并，首拉/频道切换仍替换
  const loadedChannelRef = useRef<string | null>(null);
  // hasMore 判定需要当前列表快照（本地最老消息是否落在最新一页内），用 ref 避免
  // fetchMessages 依赖 messages 导致频道切换 effect 随每条 SSE 消息重触发
  const messagesRef = useRef<ChannelMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const fetchMessages = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await channelApi.listMessages(channelId);
      if (loadedChannelRef.current === channelId) {
        // 合并路径：prepend 的历史页不丢；hasMore 仅当本地最老消息落在最新一页内
        // （未 prepend 出页外）才以响应为准——页的 hasMore 描述头部方向，直接覆盖会
        // 把已耗尽的 prepend 方向状态错误重置
        const oldest = messagesRef.current[0];
        setMessages(prev => mergePage(prev, res.data.data));
        if (!oldest || res.data.data.some(m => m.id === oldest.id)) {
          setHasMore(res.data.hasMore);
        }
      } else {
        setMessages(res.data.data);
        setHasMore(res.data.hasMore);
        loadedChannelRef.current = channelId;
      }
    } catch (err) {
      console.error('[Channel] Failed to fetch messages', err);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  // #313：挂载首拉 + SSE 断开 10s 兜底 + visibility 门禁统一走 useGatedPoll
  // （fetchMessages 自带 channelId 空值守卫）
  useGatedPoll(fetchMessages, 10000);

  // 频道切换立即重拉（挂载首跳已由 useGatedPoll 首拉覆盖，本 effect 跳过挂载）
  const prevChannelRef = useRef(channelId);
  useEffect(() => {
    if (prevChannelRef.current === channelId) return;
    prevChannelRef.current = channelId;
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
        const data = msg.data as { channelId?: string; messageId?: string; meta?: string | Record<string, unknown>; content?: string; message?: ChannelMessage };
        if (data?.channelId === channelId) {
          // #315（ADR 2026-08-24 D1/D2）：优先读全量 message 本体——其 meta 为后端合并后
          // 真值，消除顶层增量 meta 整体替换丢旧 key 的分叉；旧形状（无 message 字段）回退增量 patch
          if (data.message) {
            const full = data.message;
            setMessages(prev => prev.map(m => (m.id === full.id ? full : m)));
          } else if (data.messageId) {
            setMessages(prev => prev.map(m =>
              m.id === data.messageId
                // #326：patch 带 content = 拿到本体即复活清标记（「拿到全量本体即复活」唯一规则）；
                // 仅 meta 的 patch 骨架不假复活（空正文不应渲染为全量行）
                ? {
                    ...m,
                    meta: data.meta ?? m.meta,
                    ...(data.content != null ? { content: data.content as string, degraded: false } : {}),
                  }
                : m
            ));
          }
        }
      }
    });
    return unsub;
  }, [channelId, onEvent]);

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
      // #319：游标 = 锚点消息 id（原 createdAt 时间戳同毫秒撞车会漏/重）
      const res = await channelApi.listMessages(channelId, { before: oldest.id });
      const older = res.data.data;
      setMessages(prev => [...older, ...prev]);
      setHasMore(res.data.hasMore);
      return older.length > 0;
    } catch (err) {
      console.error('[Channel] Failed to load more', err);
      return false;
    }
  }, [channelId, hasMore, messages]);

  // #326 数据层降级（ADR 2026-08-25）：syncPruning 由渲染侧在首个可见消息变化时调用；
  // 降级 = 原位骨架化（planPrune 纯函数判定）；水合 = 防抖整页取数 + mergePage 归并，
  // 不触碰 hasMore（prepend 方向状态归 loadMore 独有）
  const pruneOptsRef = useRef(options?.prune);
  pruneOptsRef.current = options?.prune;
  const hydrateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrateInFlightRef = useRef(false);
  // 频道切换/卸载清防抖计时器，防旧频道水合落到新频道数据上
  useEffect(() => {
    hydrateInFlightRef.current = false;
    return () => {
      if (hydrateTimerRef.current) clearTimeout(hydrateTimerRef.current);
      hydrateTimerRef.current = null;
    };
  }, [channelId]);

  const scheduleHydration = useCallback((before: string) => {
    if (!channelId) return;
    if (hydrateTimerRef.current) clearTimeout(hydrateTimerRef.current);
    hydrateTimerRef.current = setTimeout(async () => {
      hydrateTimerRef.current = null;
      // in-flight 中不丢触发：重排等其落地后再取（防同区并发重复请求）
      if (hydrateInFlightRef.current) {
        scheduleHydration(before);
        return;
      }
      hydrateInFlightRef.current = true;
      try {
        const res = await channelApi.listMessages(channelId, { before, limit: PRUNE_HYDRATE_PAGE_LIMIT });
        // 骨架原位复活（按 id 归并）；hasMore 不动——本路径与 prepend 方向无关
        setMessages(prev => mergePage(prev, res.data.data));
      } catch (err) {
        console.error('[Channel] Failed to hydrate messages', err);
      } finally {
        hydrateInFlightRef.current = false;
      }
    }, 200);
  }, [channelId]);

  const syncPruning = useCallback((anchorMid: string | null) => {
    const plan = planPrune(messagesRef.current, anchorMid, {
      keepRecent: PRUNE_KEEP_RECENT,
      degradeDistance: PRUNE_DEGRADE_DISTANCE,
      hydrateDistance: PRUNE_HYDRATE_DISTANCE,
      ...pruneOptsRef.current,
    });
    if (plan.degradeIds.length > 0) {
      const ids = new Set(plan.degradeIds);
      setMessages(prev => prev.map(m => (ids.has(m.id) ? degradeMessage(m) : m)));
    }
    if (plan.hydrateBefore) scheduleHydration(plan.hydrateBefore);
  }, [scheduleHydration]);

  return { messages, loading, hasMore, sendMessage, loadMore, refresh: fetchMessages, syncPruning };
}
