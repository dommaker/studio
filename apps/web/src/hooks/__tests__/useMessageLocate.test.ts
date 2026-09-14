// useMessageLocate — mid→可见 完整语义单测（#530，架构评审 2026-09-14 候选 2）。
// 覆盖模块接口面：locate(mid) / locateBy(key, find) 全路径——已加载直接定位（展开线程 + 高亮 +
// unpin 内化）、多层线程根锚解析、#439 翻页定位循环、翻到底 toast 兜底、防重入（同 key 跳过 /
// 后到者赢）、高亮 2s 消退。页面装配行为见 pages/__tests__/ChannelDetailPage-quote-locate.test.tsx。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useMessageLocate } from '../useMessageLocate';
import { toast } from '../../utils/toast';
import type { ChannelMessage } from '../../api/channel';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const msg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
  content: `内容 ${id}`, workUnitId: null, replyToId: null,
  meta: '{}', createdAt: iso(0),
  ...over,
});

/** renderHook 回调内自持 messages/hasMore state——loadMore mock 翻页经 prepend 驱动重渲染，
 *  hook 渲染期快照 ref 随之刷新（仿页面 useChannelMessages 接缝） */
const setup = (initial: { messages: ChannelMessage[]; hasMore: boolean }) => {
  const unpinFromBottom = vi.fn();
  const collapsedRef = { current: new Set<string>() };
  const setCollapsedThreads = vi.fn((action: SetStateAction<Set<string>>) => {
    collapsedRef.current = typeof action === 'function' ? action(collapsedRef.current) : action;
  });
  const streamRef = { current: document.createElement('div') };
  const loadMore = vi.fn<() => Promise<boolean>>();
  const messageToItemIndex = new Map<string, number>();
  const page = {
    prepend: (_older: ChannelMessage[], _more: boolean) => {},
  };
  const hook = renderHook(() => {
    const [messages, setMessages] = useState(initial.messages);
    const [hasMore, setHasMore] = useState(initial.hasMore);
    page.prepend = (older: ChannelMessage[], more: boolean) => {
      act(() => {
        setMessages(prev => [...older, ...prev]);
        setHasMore(more);
      });
    };
    return useMessageLocate({
      messages, hasMore, loadMore,
      setCollapsedThreads: setCollapsedThreads as Dispatch<SetStateAction<Set<string>>>,
      unpinFromBottom,
      streamRef,
      virtualizer: {} as never, // virtualEnabled=false 路径不触 virtualizer
      virtualEnabled: false,
      messageToItemIndex,
    });
  });
  return { hook, loadMore, unpinFromBottom, setCollapsedThreads, collapsedRef, page };
};

describe('useMessageLocate（#530）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(toast, 'warning').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('locate 已加载目标 → 高亮 + unpin 内化（不靠调用方记得），不翻页', () => {
    const { hook, loadMore, unpinFromBottom } = setup({ messages: [msg('m1'), msg('m2')], hasMore: true });

    act(() => hook.result.current.locate('m1'));

    expect(hook.result.current.highlightId).toBe('m1');
    expect(unpinFromBottom).toHaveBeenCalledTimes(1);
    expect(loadMore).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('locate 已加载、埋在多层线程的目标 → 根锚解析后移除收起标记（既有 rootAnchorIdOf 行为）', () => {
    const messages = [
      msg('t-root'),
      msg('t-mid', { replyToId: 't-root' }),
      msg('t-leaf', { replyToId: 't-mid' }),
    ];
    const { hook, setCollapsedThreads, collapsedRef } = setup({ messages, hasMore: false });
    collapsedRef.current = new Set(['t-root']); // 用户手动收起了根线程

    act(() => hook.result.current.locate('t-leaf'));

    expect(setCollapsedThreads).toHaveBeenCalled();
    expect(collapsedRef.current.has('t-root')).toBe(false); // 根线程已展开
    expect(hook.result.current.highlightId).toBe('t-leaf');
  });

  it('locate 未加载目标 → 翻页定位循环加载所在页后高亮', async () => {
    const target = msg('m-old');
    const { hook, loadMore, unpinFromBottom, page } = setup({ messages: [msg('m1')], hasMore: true });
    loadMore.mockImplementation(async () => {
      page.prepend([target], false);
      return true;
    });

    act(() => hook.result.current.locate('m-old'));

    await waitFor(() => expect(hook.result.current.highlightId).toBe('m-old'));
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(unpinFromBottom).toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('locate 翻到底仍无目标 → toast 兜底不静默，不高亮', async () => {
    const { hook, loadMore, page } = setup({ messages: [msg('m1')], hasMore: true });
    loadMore.mockImplementation(async () => {
      page.prepend([], false); // 翻一页后到底，目标始终不存在
      return true;
    });

    act(() => hook.result.current.locate('m-ghost'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('该消息太旧或已删除，无法定位'));
    expect(hook.result.current.highlightId).toBeNull();
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('防重入：同 key 翻页途中重复 locate → 不起第二个翻页循环', async () => {
    const { hook, loadMore, page } = setup({ messages: [msg('m1')], hasMore: true });
    let release: (() => void) | null = null;
    loadMore.mockImplementation(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));

    act(() => hook.result.current.locate('m-a'));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.locate('m-a')); // 翻页途中重入同 mid

    expect(loadMore).toHaveBeenCalledTimes(1); // 没有第二个循环
    // 收尾：翻到底（无新内容），toast 兜底
    await act(async () => {
      release?.();
      page.prepend([], false);
    });
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  });

  it('后到者赢：翻页途中 locate 另一 mid → 旧循环 cancelled 无终局反馈，新定位生效', async () => {
    const both = [msg('m-a'), msg('m-b')]; // 同一页里同时有新旧目标
    const { hook, loadMore, page } = setup({ messages: [msg('m1')], hasMore: true });
    loadMore.mockImplementation(async () => {
      page.prepend(both, false);
      return true;
    });

    act(() => hook.result.current.locate('m-a'));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.locate('m-b'));

    await waitFor(() => expect(hook.result.current.highlightId).toBe('m-b'));
    // m-a 虽已随同页加载，旧循环已 cancelled：不高亮、不 toast
    expect(hook.result.current.highlightId).not.toBe('m-a');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('已加载快路径取消在途翻页循环：旧循环不再覆盖高亮、不补 toast', async () => {
    const { hook, loadMore, page } = setup({ messages: [msg('m1')], hasMore: true });
    let release: (() => void) | null = null;
    loadMore.mockImplementation(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));

    act(() => hook.result.current.locate('m-a')); // 未加载，开始翻页
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.locate('m1')); // 已加载快路径 → 取消在途循环
    expect(hook.result.current.highlightId).toBe('m1');

    // 在途循环的翻页落地（m-a 出现）：旧循环已 cancelled，不覆盖 m1 的高亮、无终局反馈
    await act(async () => {
      release?.();
      page.prepend([msg('m-a')], false);
    });
    await new Promise(r => setTimeout(r, 10)); // 让旧循环跑完 cancelled 分支
    expect(hook.result.current.highlightId).toBe('m1');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('locateBy：wu 语义 predicate 翻页期间按新快照重评估（chip 提问定位口径）', async () => {
    const question = msg('m-q', { workUnitId: 'wu-1' });
    const { hook, loadMore, page } = setup({
      messages: [msg('m-human', { authorType: 'human', workUnitId: 'wu-1' })],
      hasMore: true,
    });
    loadMore.mockImplementation(async () => {
      page.prepend([question], false);
      return true;
    });
    const latestQuestionOf = (msgs: ChannelMessage[]) =>
      msgs.filter(m => m.workUnitId === 'wu-1' && m.authorType !== 'human').pop() ?? null;

    act(() => hook.result.current.locateBy('wu:wu-1', latestQuestionOf));

    await waitFor(() => expect(hook.result.current.highlightId).toBe('m-q'));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('高亮 2s 后消退', () => {
    vi.useFakeTimers();
    const { hook } = setup({ messages: [msg('m1')], hasMore: false });

    act(() => hook.result.current.locate('m1'));
    expect(hook.result.current.highlightId).toBe('m1');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(hook.result.current.highlightId).toBeNull();
  });
});
