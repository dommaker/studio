// 消息定位模块（#530，架构评审 2026-09-14 候选 2）：mid→可见 完整语义一个入口。
// 自 ChannelDetailPage 整块收编：#439 翻页定位循环（上限
// HIGHLIGHT_LOCATE_MAX_PAGES 页，翻到底/超限/无新内容 → toast 兜底不静默）、
// 根锚解析展开收起线程（rootAnchorIdOf 既有行为不变）、高亮生命周期（滚动 + 2s 消退）、
// unpin（定位 = 离底意图）与防重入不变量全部内化，不再靠调用方记得。
// 一处刻意收严（计划边界 3）：防重入从 mid/chip 双台账并发并为单飞——后到者赢，
// 任何新定位意图（含已加载快路径）取消在途翻页循环（原双循环共享翻页游标互踩）。
// 三条调用链（quote 引用块 / chip 提问定位 / ?highlight 通知直达）退化为 locate/locateBy 调用。
// 边界：useStreamFollow 底座不动（unpinFromBottom 由它提供，本模块只负责调用时机——高亮 effect 内）；
// wu→mid 口径（latestQuestionMessageOf）是 chip 语义，留调用方经 locateBy 的 find 传入。
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { ChannelMessage } from '../api/channel';
import { rootAnchorIdOf } from '../utils/streamView';
import { toast } from '../utils/toast';

/** #439：翻页定位的页数上限（50 条/页 → 最多回看 500 条），超限/翻到底降级为可见反馈 */
const HIGHLIGHT_LOCATE_MAX_PAGES = 10;

export interface UseMessageLocateOptions {
  messages: ChannelMessage[];
  hasMore: boolean;
  loadMore: () => Promise<boolean>;
  /** 展开被收起线程的唯一写口（usePersistentStreamUI 的 setCollapsedThreads） */
  setCollapsedThreads: Dispatch<SetStateAction<Set<string>>>;
  /** useStreamFollow 的 unpinFromBottom——定位跳转 = 离开底部的导航意图，模块在高亮 effect 内调用 */
  unpinFromBottom: () => void;
  streamRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  virtualEnabled: boolean;
  /** 消息 id → item index（#325 virtualizer scrollToIndex 的桥；virtualEnabled=false 时不用） */
  messageToItemIndex: Map<string, number>;
}

/** 目标解析器：从当前已加载消息集求目标（mid 直查 / wu 最新提问等调用方口径），
 *  翻页定位循环每页按新快照重评估 */
export type LocateFind = (msgs: ChannelMessage[]) => ChannelMessage | null;

export function useMessageLocate({
  messages, hasMore, loadMore,
  setCollapsedThreads, unpinFromBottom,
  streamRef, virtualizer, virtualEnabled, messageToItemIndex,
}: UseMessageLocateOptions) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // 翻页定位循环是异步长任务，经 ref 读最新快照，避免闭包锁旧值（#439 引入）
  const snapshotRef = useRef({ messages, hasMore, loadMore });
  snapshotRef.current = { messages, hasMore, loadMore };
  // 防重入台账（单飞）：同 key 重入跳过；不同 key 后到者赢——旧循环经 cancelled() 放弃且无终局反馈
  // （#530 收严：原 mid/chip 双台账并发翻页共享游标互踩，合并为单台账）
  const inFlightRef = useRef<string | null>(null);

  // 定位到埋在被收起线程里的目标消息前，移除其锚点的收起标记（默认已展开，
  // 本来就不在 collapsedThreads → 返回原引用，不制造无意义新 Set 触发重渲）
  const ensureThreadExpanded = useCallback((anchorId: string) => {
    setCollapsedThreads(prev => {
      if (!prev.has(anchorId)) return prev;
      const next = new Set(prev);
      next.delete(anchorId);
      return next;
    });
  }, [setCollapsedThreads]);

  // Phase 2（AC2）归组泛化：目标的 replyToId 不一定是线程根（多层回复拍平后，父可能只是线程
  // 里的某条回复）；先沿链解析根 anchor 再展开。根解析不出（非回复/链断裂）→ 不动折叠状态。
  const expandThreadOf = useCallback((target: ChannelMessage) => {
    if (!target.replyToId) return;
    const byId = new Map(snapshotRef.current.messages.map(m => [m.id, m]));
    const rootId = rootAnchorIdOf(target, byId);
    if (rootId) ensureThreadExpanded(rootId);
  }, [ensureThreadExpanded]);

  /** #439 翻页定位循环：沿 #319 翻页游标向前翻，直到 find() 命中 / 翻到底 /
   *  超 HIGHLIGHT_LOCATE_MAX_PAGES / 翻页无新内容；cancelled() 为真则放弃（无终局反馈） */
  const pageBackToFind = useCallback(async (
    find: LocateFind,
    cancelled: () => boolean,
  ): Promise<'found' | 'cancelled' | 'exhausted'> => {
    for (let page = 0; page < HIGHLIGHT_LOCATE_MAX_PAGES; page++) {
      if (cancelled()) return 'cancelled';
      if (find(snapshotRef.current.messages)) return 'found';
      if (!snapshotRef.current.hasMore) break; // 翻到底
      const prepended = await snapshotRef.current.loadMore();
      if (!prepended) break; // 翻页失败/无新内容，终止防空转
      // loadMore resolve 时 React 尚未提交新快照——让出一个 macrotask 等 ref 刷新，
      // 否则下一轮判空读旧快照会多翻一页（目标恰在末页时甚至可能误报不可达）
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (cancelled()) return 'cancelled';
    return find(snapshotRef.current.messages) ? 'found' : 'exhausted';
  }, []);

  /** 定位通用路径：已加载 → 展开所在收起线程 + 高亮；未加载 → 翻页定位循环，
   *  exhausted → toast 兜底不静默。防重入按 key 粒度（同 key 重复触发不并发翻页） */
  const locateBy = useCallback((key: string, find: LocateFind) => {
    const loaded = find(snapshotRef.current.messages);
    if (loaded) {
      inFlightRef.current = null; // 任何新定位意图取消在途翻页循环（含快路径）
      expandThreadOf(loaded);
      setHighlightId(loaded.id);
      return;
    }
    if (inFlightRef.current === key) return; // 同 key 防重入
    inFlightRef.current = key;
    void (async () => {
      const result = await pageBackToFind(find, () => inFlightRef.current !== key);
      if (result === 'cancelled') return;
      inFlightRef.current = null;
      const target = find(snapshotRef.current.messages);
      if (target) {
        expandThreadOf(target);
        setHighlightId(target.id);
      } else {
        toast.warning('该消息太旧或已删除，无法定位');
      }
    })();
  }, [expandThreadOf, pageBackToFind]);

  /** mid → 可见：quote 引用块 / reply 预览条 / ?highlight 直达共用入口 */
  const locate = useCallback((mid: string) => {
    locateBy(`mid:${mid}`, msgs => msgs.find(m => m.id === mid) ?? null);
  }, [locateBy]);

  // 高亮生命周期内化：定位跳转 = 离开底部的导航意图，先解钉（#439 走查修复——否则钉底跟随
  // 在后续 messages 变化时把视口拽回底部，与定位滚动振荡）；滚动到目标（未渲染 → scrollToIndex
  // 带入窗口）；2s 后消退
  useEffect(() => {
    if (!highlightId) return;
    unpinFromBottom();
    const el = streamRef.current?.querySelector(`[data-message-id="${highlightId}"]`);
    if (el) {
      // jsdom 无 scrollIntoView 实现，?. 兜底
      (el as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    } else if (virtualEnabled) {
      // #325：目标行未渲染（掉出窗口）→ 先 scrollToIndex 把它带入窗口
      const idx = messageToItemIndex.get(highlightId);
      if (idx != null) virtualizer.scrollToIndex(idx, { align: 'center' });
    }
    const timer = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightId, streamRef, virtualEnabled, messageToItemIndex, virtualizer, unpinFromBottom]);

  return { highlightId, locate, locateBy };
}
