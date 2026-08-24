// 频道消息流滚动状态机（#322 自 ChannelDetailPage 整块搬移，PURE_MOVE 行为零变化）：
// 打开定位最新；程序写 scrollTop 必记 observedTopRef 台账，scroll 事件偏离台账才算读者滚动；
// 新消息仅在钉底中或自己发送时跟随；ResizeObserver 跟随卡片展开等撑高；离底浮出「回到底部」；
// #290（清单 #22/#27）：加载更早走行锚点补偿（不依赖总高度差）；阅读位置按频道持久化（localStorage）。
// 几何判定复用 utils/streamFollow 纯函数；阅读位置序列化复用 utils/readingPosition。
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import type { ChannelMessage } from '../api/channel';
import { isPinnedToBottom, isReaderScroll, shouldFollowBottom, captureFirstVisibleAnchor, anchorScrollDelta, type ScrollAnchor, type MessageRowRect } from '../utils/streamFollow';
import { loadReadingPosition, saveReadingPosition, type ReadingPosition } from '../utils/readingPosition';

export interface UseStreamFollowOptions {
  channelId: string | undefined;
  messages: ChannelMessage[];
  loading: boolean;
  loadMore: () => Promise<boolean>;
}

export function useStreamFollow({ channelId, messages, loading, loadMore }: UseStreamFollowOptions) {
  const streamRef = useRef<HTMLDivElement>(null);
  const streamInnerRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef<{ initial: boolean; anchor: ScrollAnchor | null }>({ initial: true, anchor: null });
  // observed-top 台账：记录最近一次程序写入落地后的 scrollTop（记 clamp 后实际值）
  const observedTopRef = useRef<number | null>(null);
  // 钉底状态只由读者滚动改写（几何判定见 streamFollow 纯函数）
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // 「自己发送」挂起标记：发送动作到消息落地之间的窗口置位，跟随判定据此识别自己的消息
  // （消息模型只有 authorType 无 authorId，无法精确到人；窗口内他人 human 消息会被误判为自发，可接受）
  const ownSendPendingRef = useRef(false);
  // #290（清单 #27）：阅读位置存档按 channelId 懒读（useLayoutEffect 早于 useEffect，
  // 挂载首帧被动 effect 还没跑，存档读取放在恢复分支里同步进行）
  const restoreRef = useRef<{ channelId: string | undefined; pos: ReadingPosition | null | undefined } | null>(null);
  // 当前消息集所属频道（渲染期镜像）：快速连切 A→B→C 时 B 的存档 cleanup 可能面对 A 的消息，
  // 频道不符则不存档，防把 A 的阅读位置记到 B 头上（污染存档）
  const messagesChannelRef = useRef<string | undefined>(undefined);
  messagesChannelRef.current = messages[0]?.channelId;

  // 程序滚动统一入口：写入并记账
  const scrollStreamTo = useCallback((top: number) => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = top;
    observedTopRef.current = el.scrollTop;
  }, []);

  // 捕获首个可见消息行作锚点（视口相对坐标；几何判定走 streamFollow 纯函数）
  const captureAnchor = useCallback((): ScrollAnchor | null => {
    const el = streamRef.current;
    if (!el) return null;
    const containerTop = el.getBoundingClientRect().top;
    const rows: MessageRowRect[] = Array.from(el.querySelectorAll('[data-message-id]')).map(node => {
      const rect = node.getBoundingClientRect();
      return { mid: node.getAttribute('data-message-id')!, top: rect.top - containerTop, bottom: rect.bottom - containerTop };
    });
    return captureFirstVisibleAnchor(rows);
  }, []);

  // 锚行当前视口相对 top（找不到返回 null：锚消息被清理/未渲染）
  const anchorRowTop = useCallback((mid: string): number | null => {
    const el = streamRef.current;
    if (!el) return null;
    const row = el.querySelector(`[data-message-id="${mid}"]`);
    if (!row) return null;
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, []);

  const pinAndJumpToBottom = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    scrollStreamTo(el.scrollHeight);
  }, [scrollStreamTo]);

  // scroll 事件归属判定：偏离台账才算读者滚动，读者滚动才改写钉底状态
  const handleStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    if (isReaderScroll(el.scrollTop, observedTopRef.current)) {
      const pinned = isPinnedToBottom(el);
      pinnedRef.current = pinned;
      setShowJumpToBottom(!pinned);
    }
    // 无论归属都续记实际位置：浏览器 shrink-clamp / 延迟落地的程序滚动精确落在台账上
    observedTopRef.current = el.scrollTop;
  }, []);

  // 切换频道：下一批消息到达时按存档恢复阅读位置（无存档/钉底则定位底部）；
  // cleanup（切走/卸载，此时 DOM 仍是旧频道消息）存档旧频道阅读位置——钉底存 null，否则记首个可见行
  useEffect(() => {
    const currentId = channelId;
    scrollStateRef.current.initial = true;
    ownSendPendingRef.current = false;
    restoreRef.current = null; // 换频道强制重读存档（防复用上次恢复的残值）
    return () => {
      if (!currentId) return;
      // 消息仍属其他频道（快速连切，新频道数据未到达）→ 不存档
      if (messagesChannelRef.current && messagesChannelRef.current !== currentId) return;
      saveReadingPosition(currentId, pinnedRef.current ? null : captureAnchor());
    };
  }, [channelId, captureAnchor]);

  // #290（清单 #22）：行锚点补偿——记录首个可见消息行；失败/无更多时清锚点防视口乱跳
  const handleLoadMore = useCallback(async () => {
    scrollStateRef.current.anchor = captureAnchor();
    const prepended = await loadMore();
    if (!prepended) scrollStateRef.current.anchor = null;
  }, [loadMore, captureAnchor]);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || messages.length === 0) return;
    const state = scrollStateRef.current;
    // 前插了更早的消息：按锚行位移校正，视口停留在原消息行（不依赖总高度差，抗加载期异步撑高）
    if (state.anchor) {
      const anchor = state.anchor;
      state.anchor = null;
      const newTop = anchorRowTop(anchor.mid);
      if (newTop !== null) scrollStreamTo(el.scrollTop + anchorScrollDelta(anchor.top, newTop));
      return;
    }
    // 初次加载完成：有阅读位置存档恢复锚行；无存档/钉底存档/锚行已不在则定位底部
    if (state.initial) {
      if (!loading) {
        state.initial = false;
        if (restoreRef.current?.channelId !== channelId) {
          restoreRef.current = { channelId, pos: channelId ? loadReadingPosition(channelId) : undefined };
        }
        const restore = restoreRef.current.pos;
        const restoreTop = restore ? anchorRowTop(restore.mid) : null;
        if (restore && restoreTop !== null) {
          pinnedRef.current = false;
          setShowJumpToBottom(true);
          scrollStreamTo(el.scrollTop + anchorScrollDelta(restore.top, restoreTop));
        } else {
          pinAndJumpToBottom();
        }
      }
      return;
    }
    // 新消息：钉底中或是自己发的，才跟随到底（他人的 human 消息不拽走阅读中的读者）
    const last = messages[messages.length - 1];
    const lastIsOwn = last?.authorType === 'human' && ownSendPendingRef.current;
    if (lastIsOwn) ownSendPendingRef.current = false;
    if (shouldFollowBottom(pinnedRef.current, lastIsOwn)) {
      pinAndJumpToBottom();
    }
  }, [messages, loading, scrollStreamTo, pinAndJumpToBottom, anchorRowTop]);

  // ResizeObserver 跟随：卡片展开/图片加载撑高内容、composer 撑高压缩视口时，钉底中则跟随
  useEffect(() => {
    const el = streamRef.current;
    const inner = streamInnerRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) scrollStreamTo(el.scrollHeight);
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollStreamTo]);

  return {
    streamRef,
    streamInnerRef,
    handleStreamScroll,
    showJumpToBottom,
    pinAndJumpToBottom,
    handleLoadMore,
    ownSendPendingRef,
  };
}
