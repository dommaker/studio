// 频道消息流组合层（#531，架构评审 2026-09-14 候选 3）：拥有「messages 到手之后到渲染之前」的
// 全部装配——原 ChannelDetailPage 按隐式顺序接的六根线（deriveStreamView memo →
// buildMessageToItemIndex（须先建 streamView.items）→ streamHead 高度 ResizeObserver（须先量
// 才能喂 virtualizer scrollMargin）→ useStreamFollow（virtualizer 所有权，吃掉前三个产出）→
// firstVisibleMid 三 kind 反解 → syncPruning 降级/水合触发（仅虚拟化路径））收进本 hook 内部，
// 顺序不变量由模块结构承载，不再靠 hook 调用位置的默契；折叠 UI 状态（usePersistentStreamUI）
// 与三个 toggle 回调一并收编。底座六件（streamView/useStreamFollow/messagePruning/streamVirtual/
// readingPosition/useChannelEvents）一律不动；取数（useChannelMessages）留页面不进组合层。
// 返回契约分两面：页面消费结构/滚动跟随/特性消费产物（locate、键盘导航 navigableIdsOf(items)、
// highlight 定位三家的即插即用口）；ChannelStreamBody 消费结构渲染产物（streamInnerRef/
// streamHeadH/三 toggle——原页面 renderStreamItem 与 mc-stream-inner JSX 的消费者随结构上移）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelMessage } from '../api/channel';
import { deriveStreamView } from '../utils/streamView';
import { buildMessageToItemIndex } from '../utils/streamVirtual';
import { usePersistentStreamUI } from './usePersistentStreamUI';
import { useStreamFollow } from './useStreamFollow';

export interface UseChannelStreamOptions {
  channelId: string | undefined;
  // 取数产物（页面既有 useChannelMessages 的返回子集；取数本体留页面）
  messages: ChannelMessage[];
  loading: boolean;
  loadMore: () => Promise<boolean>;
  // #326：数据层降级/水合触发口（仅虚拟化路径由首个可见 mid 驱动）
  syncPruning: (anchorMid: string) => void;
  // 页面业务输入（deriveStreamView 的折叠/筛选 UI 状态成员）
  promotedQuestionIds: ReadonlySet<string>;
  isWaitingForInput: (m: ChannelMessage) => boolean;
}

export function useChannelStream({
  channelId, messages, loading, loadMore, syncPruning, promotedQuestionIds, isWaitingForInput,
}: UseChannelStreamOptions) {
  // 折叠 UI 状态按频道持久化（showCompleted/collapsedThreads/expandedProcGroups/expandedAlertGroups），
  // setter 语义同 useState；线程默认全部展开，collapsedThreads 只存手动收起的锚点 id
  const {
    showCompleted, setShowCompleted,
    collapsedThreads, setCollapsedThreads,
    expandedProcGroups, setExpandedProcGroups,
    expandedAlertGroups, setExpandedAlertGroups,
  } = usePersistentStreamUI(channelId);

  // AC-C3: 线程收起/展开（2026-09 折叠层级 4→2：默认全部展开，collapsedThreads 存手动收起的锚点 id）
  const toggleThread = useCallback((anchorId: string) => {
    setCollapsedThreads(prev => {
      const next = new Set(prev);
      if (next.has(anchorId)) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });
  }, [setCollapsedThreads]);

  // 线程内过程消息组的展开状态（保持一层折叠：默认收拢，key = proc-<首条消息 id>）
  const toggleProcGroup = useCallback((key: string) => {
    setExpandedProcGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setExpandedProcGroups]);

  // Phase 3（AC3）：主流告警组展开状态（默认折叠，key = alerts-<首条消息 id>，按频道持久化）
  const toggleAlertGroup = useCallback((key: string) => {
    setExpandedAlertGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setExpandedAlertGroups]);

  // 接线顺序不变量①：#322 消息流管线——归组/过程折叠/连续合并/日期分隔/可见性走 deriveStreamView
  // 纯函数（消息引用与 UI 状态不变则零重算）；后续一切产物都建在 streamView.items 上
  const streamView = useMemo(() => deriveStreamView(messages, {
    showCompleted,
    collapsedThreads,
    expandedProcGroups,
    expandedAlertGroups,
    promotedQuestionIds,
    isWaitingForInput,
  }), [messages, showCompleted, collapsedThreads, expandedProcGroups, expandedAlertGroups, promotedQuestionIds, isWaitingForInput]);

  // 接线顺序不变量②：#325 mid→item index 映射（prepend 补偿 / 阅读位置恢复 / highlight 定位的桥），
  // 须先建 streamView.items
  const messageToItemIndex = useMemo(() => buildMessageToItemIndex(streamView.items), [streamView.items]);

  // 接线顺序不变量③：#325 滚动内容头部块（加载更早/折叠 toggle/空态）高度 → virtualizer
  // scrollMargin，须先量才能喂 useStreamFollow
  const streamHeadRef = useRef<HTMLDivElement>(null);
  const [streamHeadH, setStreamHeadH] = useState(0);
  useEffect(() => {
    const el = streamHeadRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setStreamHeadH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 接线顺序不变量④：消息流滚动状态机（#322 整块抽成 useStreamFollow，PURE_MOVE）——
  // observed-top 台账 / 钉底跟随 / 行锚点补偿 / ResizeObserver 跟随 / 阅读位置存档全在底座内；
  // #325 起 virtualizer 也建在底座内（入参吃掉前三个产出：items/messageToItemIndex/scrollMargin）
  const {
    streamRef,
    streamInnerRef,
    handleStreamScroll,
    showJumpToBottom,
    pinAndJumpToBottom,
    unpinFromBottom,
    handleLoadMore,
    ownSendPendingRef,
    awayNewCount,
    virtualizer,
    virtualEnabled,
  } = useStreamFollow({
    channelId,
    messages,
    loading,
    loadMore,
    items: streamView.items,
    messageToItemIndex,
    scrollMargin: streamHeadH,
  });

  // 接线顺序不变量⑤⑥：#326 首个可见消息 → 数据层降级/水合同步。仅虚拟化路径（jsdom 全量渲染
  // 不降级，页面测试语义不变）；首个 virtual item 含 overscan 缓冲，作为降级锚点足够
  const firstVirtual = virtualEnabled ? virtualizer.getVirtualItems()[0] : undefined;
  const firstVisibleItem = firstVirtual ? streamView.items[firstVirtual.index] : undefined;
  const firstVisibleMid = firstVisibleItem
    ? (firstVisibleItem.kind === 'thread'
      ? firstVisibleItem.anchor.id
      : firstVisibleItem.kind === 'alert-group'
        ? firstVisibleItem.messages[0]?.id ?? null
        : firstVisibleItem.message.id)
    : null;
  useEffect(() => {
    if (virtualEnabled && firstVisibleMid) syncPruning(firstVisibleMid);
  }, [virtualEnabled, firstVisibleMid, syncPruning]);

  return {
    // 结构（页面头块/键盘导航消费）
    streamHeadRef,
    items: streamView.items,
    completedCount: streamView.completedCount,
    showCompleted,
    setShowCompleted,
    // 滚动跟随（页面滚动容器/头块加载更早/回底浮钮/发送链路消费）
    streamRef,
    handleStreamScroll,
    showJumpToBottom,
    pinAndJumpToBottom,
    unpinFromBottom,
    awayNewCount,
    handleLoadMore,
    ownSendPendingRef,
    // 特性消费产物（locate / 键盘导航 / highlight 定位的即插即用口）
    messageToItemIndex,
    virtualizer,
    virtualEnabled,
    // locate（#530）的线程展开写口（usePersistentStreamUI 调用点已收编进本 hook）
    setCollapsedThreads,
    // ChannelStreamBody 结构渲染产物（原页面 renderStreamItem / mc-stream-inner JSX 的消费者）
    streamInnerRef,
    streamHeadH,
    toggleThread,
    toggleProcGroup,
    toggleAlertGroup,
  };
}

export type ChannelStream = ReturnType<typeof useChannelStream>;
