// useChannelStream — 组合层单测（#531，架构评审 2026-09-14 候选 3）。
// 覆盖本 hook 自有装配面：返回契约产出物齐全；#326 syncPruning 触发接线——
// virtualEnabled 时由首个可见 mid 驱动（三 kind 反解：message / thread anchor / alert-group 首条），
// 非虚拟路径不触发。底座 useStreamFollow 在测试接缝整体替换（stub virtualizer），
// 底座自身行为由其既有测试/纯函数测试覆盖；deriveStreamView 管线行为见其纯函数测试。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import type { UseStreamFollowOptions } from '../useStreamFollow';

// 测试接缝：stub useStreamFollow——组合层只验证「吃掉前三个产出、吐出契约产物」的接线，
// virtualEnabled/virtualizer 由用例注入（jsdom 下 STREAM_VIRTUAL_ENABLED=false，真实虚拟路径不可测）
const { mockUseStreamFollow, stubFollow } = vi.hoisted(() => {
  const stubFollow = {
    streamRef: { current: null },
    streamInnerRef: { current: null },
    handleStreamScroll: () => {},
    showJumpToBottom: false,
    pinAndJumpToBottom: () => {},
    unpinFromBottom: () => {},
    handleLoadMore: async () => false,
    ownSendPendingRef: { current: false },
    awayNewCount: 0,
    virtualizer: { getVirtualItems: () => [] as { index: number }[] },
    virtualEnabled: false,
  };
  return { mockUseStreamFollow: vi.fn(), stubFollow };
});

vi.mock('../useStreamFollow', () => ({
  useStreamFollow: (opts: UseStreamFollowOptions) => mockUseStreamFollow(opts),
}));

import { useChannelStream } from '../useChannelStream';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const msg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
  content: `内容 ${id}`, workUnitId: null, replyToId: null,
  meta: '{}', createdAt: iso(0),
  ...over,
});

/** 主流 monitor 告警（isMonitorAlert 口径：Studio 署名 + 无卡 + severity 前缀） */
const alertMsg = (id: string, offsetMin: number): ChannelMessage =>
  msg(id, { agentName: 'Studio', content: `[WARNING] 告警 ${id}`, createdAt: iso(offsetMin) });

const setup = (messages: ChannelMessage[], follow: Partial<typeof stubFollow> = {}) => {
  const syncPruning = vi.fn();
  const loadMore = vi.fn<() => Promise<boolean>>(async () => false);
  mockUseStreamFollow.mockReturnValue({ ...stubFollow, ...follow });
  const hook = renderHook(() => useChannelStream({
    channelId: 'ch-1',
    messages,
    loading: false,
    loadMore,
    syncPruning,
    promotedQuestionIds: new Set(),
    isWaitingForInput: () => false,
  }));
  return { hook, syncPruning, loadMore };
};

describe('useChannelStream（#531）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('返回契约产出物齐全：结构 / 滚动跟随 / 特性消费 / ChannelStreamBody 渲染产物', () => {
    const { hook } = setup([msg('m1')]);
    const s = hook.result.current;
    // 结构
    expect(s.streamHeadRef).toBeDefined();
    expect(Array.isArray(s.items)).toBe(true);
    expect(typeof s.completedCount).toBe('number');
    expect(typeof s.showCompleted).toBe('boolean');
    expect(typeof s.setShowCompleted).toBe('function');
    // 滚动跟随
    expect(s.streamRef).toBe(stubFollow.streamRef);
    expect(typeof s.handleStreamScroll).toBe('function');
    expect(typeof s.showJumpToBottom).toBe('boolean');
    expect(typeof s.pinAndJumpToBottom).toBe('function');
    expect(typeof s.unpinFromBottom).toBe('function');
    expect(typeof s.awayNewCount).toBe('number');
    expect(typeof s.handleLoadMore).toBe('function');
    expect(s.ownSendPendingRef).toBe(stubFollow.ownSendPendingRef);
    // 特性消费产物
    expect(s.messageToItemIndex).toBeInstanceOf(Map);
    expect(s.virtualizer).toBe(stubFollow.virtualizer);
    expect(s.virtualEnabled).toBe(false);
    // locate 线程展开写口 + ChannelStreamBody 结构渲染产物
    expect(typeof s.setCollapsedThreads).toBe('function');
    expect(s.streamInnerRef).toBe(stubFollow.streamInnerRef);
    expect(typeof s.streamHeadH).toBe('number');
    expect(typeof s.toggleThread).toBe('function');
    expect(typeof s.toggleProcGroup).toBe('function');
    expect(typeof s.toggleAlertGroup).toBe('function');
  });

  it('接线顺序：useStreamFollow 吃到 items / messageToItemIndex / scrollMargin 三个上游产出', () => {
    setup([msg('m1'), msg('m2')]);
    const opts = mockUseStreamFollow.mock.calls[0][0] as UseStreamFollowOptions;
    expect(opts.items.length).toBe(2);
    expect(opts.messageToItemIndex.get('m1')).toBe(0);
    expect(opts.scrollMargin).toBe(0); // jsdom 无 ResizeObserver 布局，头部高 0
    expect(opts.channelId).toBe('ch-1');
  });

  it('非虚拟路径不触发 syncPruning', () => {
    const { syncPruning } = setup([msg('m1')], { virtualEnabled: false });
    expect(syncPruning).not.toHaveBeenCalled();
  });

  it('virtualEnabled：syncPruning 由首个可见 mid 驱动（message kind = 消息自身 id）', () => {
    const virtualizer = { getVirtualItems: () => [{ index: 0 }] };
    const { syncPruning } = setup([msg('m1'), msg('m2')], { virtualEnabled: true, virtualizer });
    expect(syncPruning).toHaveBeenCalledWith('m1');
  });

  it('virtualEnabled：首个可见为 thread kind → 以 anchor id 驱动 syncPruning', () => {
    const virtualizer = { getVirtualItems: () => [{ index: 0 }] };
    const anchor = msg('t-anchor', { workUnitId: 'wu-1' });
    const reply = msg('t-reply', { replyToId: 't-anchor', createdAt: iso(1) });
    const { syncPruning } = setup([anchor, reply], { virtualEnabled: true, virtualizer });
    expect(syncPruning).toHaveBeenCalledWith('t-anchor');
  });

  it('virtualEnabled：首个可见为 alert-group kind → 以组内首条消息 id 驱动 syncPruning', () => {
    const virtualizer = { getVirtualItems: () => [{ index: 0 }] };
    const alerts = [alertMsg('a1', 0), alertMsg('a2', 1), alertMsg('a3', 2)];
    const { syncPruning } = setup(alerts, { virtualEnabled: true, virtualizer });
    expect(syncPruning).toHaveBeenCalledWith('a1');
  });

  it('折叠状态收编：toggleThread 收起线程后 items 反映折叠态（usePersistentStreamUI 内化）', () => {
    const anchor = msg('t-anchor', { workUnitId: 'wu-1' });
    const reply = msg('t-reply', { replyToId: 't-anchor', createdAt: iso(1) });
    const { hook } = setup([anchor, reply]);
    const before = hook.result.current.items[0];
    expect(before.kind === 'thread' && before.expanded).toBe(true);
    act(() => hook.result.current.toggleThread('t-anchor'));
    const after = hook.result.current.items[0];
    expect(after.kind === 'thread' && after.expanded).toBe(false);
  });
});
