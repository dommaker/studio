// 频道消息流滚动状态机（#322 自 ChannelDetailPage 整块搬移，PURE_MOVE 行为零变化）：
// 打开定位最新；程序写 scrollTop 必记 observedTopRef 台账，scroll 事件偏离台账才算读者滚动；
// 新消息仅在钉底中或自己发送时跟随；ResizeObserver 跟随卡片展开等撑高；离底浮出「回到底部」；
// #290（清单 #22/#27）：加载更早走行锚点补偿（不依赖总高度差）；阅读位置按频道持久化（localStorage）。
// #325（ADR 2026-08-24 channel-stream-virtualization）：虚拟化接入——virtualizer 建在本 hook，
// 一切 virtualizer 滚动写入经自定义 scrollToFn 过台账（D4-5）；自动测量校正全关（D4-2 校正权独占）；
// prepend 补偿数据源 = measurements 按 key 查 start（验证约束 1，不做 prepend 后 DOM 查询）；
// 阅读位置恢复两段式（scrollToIndex 粗定位 → reconcile 收敛后 DOM 精校正；
// #339：收敛前校正会被 scrollToIndex 的 reconcile rAF 循环改写踩掉，必须等收敛后落地）。
// 钉底/跟随仍走元素几何（spacer 高 = totalSize，距底 = 末行局部几何，等价 ADR D4-4 语义）；
// STREAM_VIRTUAL_ENABLED=false（jsdom）时整条虚拟化路径不激活，行为与 #290 现状逐字节一致。
// 几何判定复用 utils/streamFollow 纯函数；阅读位置序列化复用 utils/readingPosition。
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChannelMessage } from '../api/channel';
import type { StreamItem } from '../utils/streamView';
import { isPinnedToBottom, isReaderScroll, shouldFollowBottom, captureFirstVisibleAnchor, anchorScrollDelta, type ScrollAnchor, type MessageRowRect } from '../utils/streamFollow';
import { loadReadingPosition, saveReadingPosition, type ReadingPosition } from '../utils/readingPosition';
import { STREAM_VIRTUAL_ENABLED, streamItemKey, anchorScrollTopAfterPrepend, virtualizerScrollSettled, planFineAdjust } from '../utils/streamVirtual';

/** 行高估计：消息行普遍 60~300，取 120（估计偏差只影响未测量区滚动条比例与粗定位收敛轮数） */
const ESTIMATED_ROW_PX = 120;

export interface UseStreamFollowOptions {
  channelId: string | undefined;
  messages: ChannelMessage[];
  loading: boolean;
  loadMore: () => Promise<boolean>;
  // #325 虚拟化入参（STREAM_VIRTUAL_ENABLED=false 时忽略，行为与现状一致）
  items: StreamItem[];
  /** 消息 id → item index（含 thread replies/过程组内消息），prepend 补偿与恢复的 mid→item 桥 */
  messageToItemIndex: Map<string, number>;
  /** 滚动内容头部块（加载更早/折叠 toggle/空态）高度，virtualizer scrollMargin */
  scrollMargin: number;
}

/** 锚点扩展：虚拟化路径携带 item key 与 item 内偏移（measurements 补偿用） */
type StreamAnchor = ScrollAnchor & { itemKey?: string; withinItemOffset?: number };

export function useStreamFollow({ channelId, messages, loading, loadMore, items, messageToItemIndex, scrollMargin }: UseStreamFollowOptions) {
  const streamRef = useRef<HTMLDivElement>(null);
  const streamInnerRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef<{ initial: boolean; anchor: StreamAnchor | null }>({ initial: true, anchor: null });
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
  // 阅读位置恢复两段式的第二段挂起标记：粗定位（scrollToIndex）后等锚行进 DOM 再做精校正
  const pendingFineAdjustRef = useRef<ScrollAnchor | null>(null);
  // 当前消息集所属频道（渲染期镜像）：快速连切 A→B→C 时 B 的存档 cleanup 可能面对 A 的消息，
  // 频道不符则不存档，防把 A 的阅读位置记到 B 头上（污染存档）
  const messagesChannelRef = useRef<string | undefined>(undefined);
  messagesChannelRef.current = messages[0]?.channelId;
  // #326：消息渲染期镜像——存档/恢复时查锚行是否骨架（粗锚判定），不引入 effect 依赖
  const messagesMirrorRef = useRef<ChannelMessage[]>(messages);
  messagesMirrorRef.current = messages;

  const virtualEnabled = STREAM_VIRTUAL_ENABLED;

  // 程序滚动统一入口：写入并记账
  const scrollStreamTo = useCallback((top: number) => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = top;
    observedTopRef.current = el.scrollTop;
  }, []);

  // #325：virtualizer——只管窗口计算，滚动/锚点语义仍由本状态机持有。
  // scrollToFn 自定义：virtualizer 的一切滚动写入（scrollToIndex/scrollToEnd/动态重算/测量校正）
  // 全部过台账，不被误判为读者滚动（D4-5）。offset 语义 = 滚动内容坐标（start 已含 scrollMargin）。
  const scrollToFn = useCallback((offset: number, { adjustments = 0 }: { adjustments?: number }) => {
    scrollStreamTo(offset + adjustments);
  }, [scrollStreamTo]);
  const getItemKey = useCallback((index: number) => streamItemKey(items[index]), [items]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => streamRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey,
    overscan: 8,
    scrollMargin,
    enabled: virtualEnabled,
    scrollToFn,
  });
  // D4-2 校正权独占：prepend 补偿/跟随/恢复全走自家逻辑，virtualizer 自动测量校正全关
  useEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  }, [virtualizer]);

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

  // 阅读位置恢复第二段（#339）：scrollToIndex 会置 virtualizer 内部 scrollState 并跑 rAF
  // reconcile 循环，测量落地期间反复把 scrollTop 改写回 align-start 目标——精校正落地于
  // 该窗口内必被踩掉（issue #339 实测根因）。故改为：收敛（scrollState 清空）后一次性落地。
  // 收敛发生在 rAF 回调、不触发 React 提交，every-render effect 观察不到，须自驱 rAF 轮询。
  const fineAdjustRafRef = useRef<number | null>(null);
  const fineAdjustMissingFramesRef = useRef(0);
  const stopFineAdjustPoll = useCallback(() => {
    if (fineAdjustRafRef.current != null) {
      cancelAnimationFrame(fineAdjustRafRef.current);
      fineAdjustRafRef.current = null;
    }
  }, []);
  const startFineAdjustPoll = useCallback(() => {
    stopFineAdjustPoll();
    fineAdjustMissingFramesRef.current = 0;
    const step = () => {
      fineAdjustRafRef.current = null;
      const pending = pendingFineAdjustRef.current;
      if (!pending) return; // 已放弃（读者滚动/换频道/回底）
      const el = streamRef.current;
      const settled = virtualizerScrollSettled(virtualizer);
      const anchorTop = settled && el ? anchorRowTop(pending.mid) : null;
      if (settled && anchorTop === null) fineAdjustMissingFramesRef.current += 1;
      else fineAdjustMissingFramesRef.current = 0;
      // 决策分支（wait/abandon/apply/宽限/读者在途）全在 planFineAdjust 纯函数，接线保持机械
      const decision = planFineAdjust({
        pending,
        settled,
        anchorTop,
        settledMissingFrames: fineAdjustMissingFramesRef.current,
        readerScrollInFlight: !!el && isReaderScroll(el.scrollTop, observedTopRef.current),
      });
      if (decision.action === 'wait') {
        fineAdjustRafRef.current = requestAnimationFrame(step);
        return;
      }
      pendingFineAdjustRef.current = null;
      if (decision.action === 'apply' && el) {
        scrollStreamTo(el.scrollTop + decision.delta);
      }
    };
    fineAdjustRafRef.current = requestAnimationFrame(step);
  }, [stopFineAdjustPoll, virtualizer, anchorRowTop, scrollStreamTo]);
  // 卸载取消在途轮询（换频道不清：下一帧见 pending 为空自然退出）
  useEffect(() => stopFineAdjustPoll, [stopFineAdjustPoll]);

  const pinAndJumpToBottom = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    pendingFineAdjustRef.current = null; // 回底（按钮/自发消息跟随）= 离开存档位置，放弃未落地的精校正
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    // 写超出值由浏览器 clamp 到最大偏移；spacer 高 = totalSize，落点即末行底（等价 D4-4 末行语义）
    scrollStreamTo(el.scrollHeight);
  }, [scrollStreamTo]);

  // scroll 事件归属判定：偏离台账才算读者滚动，读者滚动才改写钉底状态
  const handleStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    if (isReaderScroll(el.scrollTop, observedTopRef.current)) {
      pendingFineAdjustRef.current = null; // 读者滚动意图优先：放弃未落地的精校正（#339）
      const pinned = isPinnedToBottom(el);
      pinnedRef.current = pinned;
      setShowJumpToBottom(!pinned);
    }
    // 无论归属都续记实际位置：浏览器 shrink-clamp / 延迟落地的程序滚动精确落在台账上
    observedTopRef.current = el.scrollTop;
  }, []);

  // 切换频道：下一批消息到达时按存档恢复阅读位置（无存档/钉底则定位底部）；
  // cleanup（切走/卸载，此时 DOM 仍是旧频道消息）存档旧频道阅读位置——钉底存 null，否则记首个可见行。
  // 必须挂 layout effect（#340）：卸载时 React 删除遍历先跑组件自身 layout destroy、
  // 后遍历子树（ref detach + DOM 移除），layout cleanup 里 streamRef 仍指向文档内节点，
  // captureAnchor 才量得到；passive cleanup 时 ref 已 detach，存档恒为 null。
  useLayoutEffect(() => {
    const currentId = channelId;
    scrollStateRef.current.initial = true;
    ownSendPendingRef.current = false;
    pendingFineAdjustRef.current = null; // 换频道放弃未落地的精校正
    restoreRef.current = null; // 换频道强制重读存档（防复用上次恢复的残值）
    return () => {
      if (!currentId) return;
      // 消息仍属其他频道（快速连切，新频道数据未到达）→ 不存档
      if (messagesChannelRef.current && messagesChannelRef.current !== currentId) return;
      const anchor = pinnedRef.current ? null : captureAnchor();
      // #326 粗锚：锚行是骨架（已降级）→ 存档带 coarse，恢复只做行级定位不做像素精校正
      const anchorDegraded = anchor != null
        && messagesMirrorRef.current.some(m => m.id === anchor.mid && m.degraded);
      saveReadingPosition(currentId, anchor && anchorDegraded ? { ...anchor, coarse: true } : anchor);
    };
  }, [channelId, captureAnchor]);

  // #290（清单 #22）：行锚点补偿——记录首个可见消息行；失败/无更多时清锚点防视口乱跳
  // #325：虚拟化路径额外捕获 item key + item 内偏移（prepend 后锚行掉出渲染窗口，
  // 补偿数据源只能是 measurements，验证约束 1）
  const handleLoadMore = useCallback(async () => {
    const anchor = captureAnchor();
    if (virtualEnabled && anchor) {
      const el = streamRef.current;
      const idx = messageToItemIndex.get(anchor.mid);
      const meas = idx != null && el ? virtualizer.measurementsCache[idx] : undefined;
      if (meas) {
        const withinItemOffset = (el.scrollTop + anchor.top) - meas.start;
        scrollStateRef.current.anchor = { ...anchor, itemKey: String(meas.key), withinItemOffset };
      } else {
        // mid→item 映射缺失（理论上首个可见行必在映射中）：退化 DOM 补偿，风险同现状
        scrollStateRef.current.anchor = anchor;
      }
    } else {
      scrollStateRef.current.anchor = anchor;
    }
    const prepended = await loadMore();
    if (!prepended) scrollStateRef.current.anchor = null;
  }, [loadMore, captureAnchor, virtualEnabled, messageToItemIndex, virtualizer]);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || messages.length === 0) return;
    const state = scrollStateRef.current;
    // 前插了更早的消息：按锚行位移校正，视口停留在原消息行
    if (state.anchor) {
      const anchor = state.anchor;
      state.anchor = null;
      // 虚拟化路径：measurements 按 key 查 item 新 start（估计坐标系内自洽，渲染 translateY 同源）
      if (virtualEnabled && anchor.itemKey != null && anchor.withinItemOffset != null) {
        const meas = virtualizer.measurementsCache.find(m => String(m.key) === anchor.itemKey);
        // key 丢失（折叠/过滤变化吃掉锚项）→ 不补偿，视口停原处（同现状清锚语义）
        if (meas) {
          scrollStreamTo(anchorScrollTopAfterPrepend({
            newItemStart: meas.start,
            withinItemOffset: anchor.withinItemOffset,
            anchorTop: anchor.top,
          }));
        }
        return;
      }
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
        if (virtualEnabled) {
          // 两段式：scrollToIndex 粗定位（自带动态重算收敛，验证约束 3）→ 锚行进 DOM 后精校正
          const idx = restore ? messageToItemIndex.get(restore.mid) : undefined;
          if (restore && idx != null) {
            pinnedRef.current = false;
            setShowJumpToBottom(true);
            // #326 粗锚：存档为粗锚或锚行当前是骨架 → 行级定位即完成，不精校正
            // （水合由 syncPruning 随首个可见行变化自然触发）
            const coarseRestore = restore.coarse === true
              || messagesMirrorRef.current.some(m => m.id === restore.mid && m.degraded);
            pendingFineAdjustRef.current = coarseRestore ? null : restore;
            virtualizer.scrollToIndex(idx, { align: 'start' });
            if (pendingFineAdjustRef.current) startFineAdjustPoll();
          } else {
            // 无存档/钉底存档/锚行不在已加载集 → 定位底部（兜底语义同现状）
            pinAndJumpToBottom();
          }
          return;
        }
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
  }, [messages, loading, scrollStreamTo, pinAndJumpToBottom, anchorRowTop, virtualEnabled, messageToItemIndex, virtualizer, startFineAdjustPoll]);

  // 旧 every-render 精校正 effect 已删除（#339）：锚行首次进 DOM 即落地，正落在
  // scrollToIndex 的 reconcile 收敛窗口内，落地即被后续改写踩掉——现由上方 rAF 轮询接管。

  // ResizeObserver 跟随：卡片展开/图片加载撑高内容、composer 撑高压缩视口时，钉底中则跟随
  // （虚拟化下 spacer 高 = totalSize，行测量落地/新行追加同样触发 inner 尺寸变化，语义不变）
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
    // #325：渲染段窗口化消费（virtualEnabled=false 时忽略，全量渲染）
    virtualizer,
    virtualEnabled,
  };
}
