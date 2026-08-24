// useChannelMessages — #287（清单 P2 #19）：去重 / 有序归组 / 孤儿归并
// 核心不变式：messages 恒按 createdAt 升序——下游 groupIntoThreads 单遍归组
// 要求 anchor 先于 reply 出现，增量到达（SSE/轮询/发送）不得破坏该顺序，
// 否则同一线程回复在刷新前后出现两种位置（走查 F17）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import type { WebSocketMessage } from '../../api/websocketHooks';

const { mockListMessages, mockSendMessage, mockOnEvent, mockCtx } = vi.hoisted(() => ({
  mockListMessages: vi.fn(),
  mockSendMessage: vi.fn(),
  mockOnEvent: vi.fn(),
  mockCtx: { status: 'connected' as string },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listMessages: mockListMessages, sendMessage: mockSendMessage },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, status: mockCtx.status }),
}));

import { useChannelMessages } from '../useChannelEvents';

const iso = (s: number) => new Date(s * 1000).toISOString();

let seq = 0;
function msg(id: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'agent',
    content: `内容-${id}`,
    replyToId: null,
    workUnitId: null,
    meta: '{}',
    createdAt: iso(seq++),
    ...over,
  };
}

function sseMessage(message: ChannelMessage): WebSocketMessage {
  return {
    event_id: `ev-${message.id}`,
    event_type: 'channel.message_sent',
    timestamp: message.createdAt,
    data: { channelId: 'ch-1', message },
  };
}

describe('useChannelMessages', () => {
  let handler: (msg: WebSocketMessage) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
    mockOnEvent.mockImplementation((h: (msg: WebSocketMessage) => void) => {
      handler = h;
      return () => {};
    });
  });

  async function renderLoaded(initial: ChannelMessage[] = []) {
    mockListMessages.mockResolvedValue({ data: { data: initial, hasMore: false } });
    const { result } = renderHook(() => useChannelMessages('ch-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    return result;
  }

  it('initial load fetches messages for the channel', async () => {
    const m1 = msg('m1');
    const result = await renderLoaded([m1]);
    expect(mockListMessages).toHaveBeenCalledWith('ch-1');
    expect(result.current.messages.map(m => m.id)).toEqual(['m1']);
  });

  it('dedups SSE event arriving after own send returns', async () => {
    const result = await renderLoaded([]);
    const sent = msg('s1', { authorType: 'human', createdAt: iso(10) });
    mockSendMessage.mockResolvedValue({ data: { data: sent } });

    await act(async () => {
      await result.current.sendMessage('你好');
    });
    act(() => handler(sseMessage(sent)));

    expect(result.current.messages.filter(m => m.id === 's1')).toHaveLength(1);
  });

  it('inserts out-of-order incremental arrival by createdAt, not blind tail-push', async () => {
    const m1 = msg('m1', { createdAt: iso(0) });
    const m3 = msg('m3', { createdAt: iso(2) });
    const result = await renderLoaded([m1, m3]);

    // 乱序到达：createdAt 介于 m1/m3 之间（如轮询/重发补到）
    const m2 = msg('m2', { createdAt: iso(1) });
    act(() => handler(sseMessage(m2)));

    expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps anchor-before-reply invariant so thread replies group on incremental arrival', async () => {
    const anchor = msg('a1', { workUnitId: 'WU-1', createdAt: iso(0) });
    const tail = msg('x1', { createdAt: iso(2) });
    const result = await renderLoaded([anchor, tail]);

    // 增量到达的线程回复：必须落在 anchor 之后、按时间归位，而非追加流尾
    const reply = msg('r1', { replyToId: 'a1', createdAt: iso(1) });
    act(() => handler(sseMessage(reply)));

    expect(result.current.messages.map(m => m.id)).toEqual(['a1', 'r1', 'x1']);
  });

  it('merges orphan reply when its anchor arrives later', async () => {
    const base = msg('b1', { createdAt: iso(0) });
    const result = await renderLoaded([base]);

    // 回复先于 anchor 到达：暂居主流（按时间位置）
    const orphan = msg('r1', { replyToId: 'a1', createdAt: iso(2) });
    act(() => handler(sseMessage(orphan)));
    expect(result.current.messages.map(m => m.id)).toEqual(['b1', 'r1']);

    // anchor 到达后插到回复之前——groupIntoThreads 归组成立，不永久滞留主流
    const anchor = msg('a1', { workUnitId: 'WU-1', createdAt: iso(1) });
    act(() => handler(sseMessage(anchor)));

    expect(result.current.messages.map(m => m.id)).toEqual(['b1', 'a1', 'r1']);
  });

  // #315（ADR 2026-08-24 D1/D2）：消费端迁移读全量 message 本体，旧形状回退增量 patch
  describe('channel.message_updated', () => {
    function sseUpdate(data: Record<string, unknown>): WebSocketMessage {
      return { event_id: 'ev-upd', event_type: 'channel.message_updated', timestamp: iso(99), data };
    }

    it('replaces the message in place with the full message body when present', async () => {
      const m1 = msg('m1', { content: '旧内容', meta: '{"k1":"a"}', createdAt: iso(0) });
      const result = await renderLoaded([m1]);

      const full = { ...m1, content: '新内容', meta: { k1: 'a', k2: 'b' } };
      act(() => handler(sseUpdate({ channelId: 'ch-1', messageId: 'm1', content: '新内容', meta: { k2: 'b' }, message: full })));

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toEqual(full);
      // 无 REST 补拉：仅初值覆盖一次
      expect(mockListMessages).toHaveBeenCalledTimes(1);
    });

    it('meta-only update keeps old meta keys via merged message.meta truth', async () => {
      const m1 = msg('m1', { meta: '{"k1":"a"}', createdAt: iso(0) });
      const result = await renderLoaded([m1]);

      // 模拟 updateMessage 仅传 meta：顶层 meta 是增量输入原值，message.meta 才是合并真值
      const full = { ...m1, meta: { k1: 'a', k2: 'b' } };
      act(() => handler(sseUpdate({ channelId: 'ch-1', messageId: 'm1', meta: { k2: 'b' }, message: full })));

      expect(result.current.messages[0].meta).toEqual({ k1: 'a', k2: 'b' });
    });

    it('falls back to incremental patch for legacy shape without message field', async () => {
      const m1 = msg('m1', { content: '旧内容', meta: '{"k1":"a"}', createdAt: iso(0) });
      const result = await renderLoaded([m1]);

      act(() => handler(sseUpdate({ channelId: 'ch-1', messageId: 'm1', meta: { k2: 'b' } })));

      // 与现状逐字节一致：meta 整体替换、content 无增量字段时保留
      expect(result.current.messages[0].meta).toEqual({ k2: 'b' });
      expect(result.current.messages[0].content).toBe('旧内容');
    });

    it('does not touch other messages when message.id has no local match', async () => {
      const m1 = msg('m1', { createdAt: iso(0) });
      const m2 = msg('m2', { createdAt: iso(1) });
      const result = await renderLoaded([m1, m2]);

      const ghost = msg('ghost', { content: '不存在' });
      act(() => handler(sseUpdate({ channelId: 'ch-1', messageId: 'ghost', message: ghost })));

      expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm2']);
      expect(result.current.messages[0]).toEqual(m1);
      expect(result.current.messages[1]).toEqual(m2);
    });
  });

  it('ignores SSE events of other channels', async () => {
    const result = await renderLoaded([]);
    const other = msg('o1', { channelId: 'ch-2', createdAt: iso(1) });
    act(() => {
      handler({
        event_id: 'ev-o1',
        event_type: 'channel.message_sent',
        timestamp: other.createdAt,
        data: { channelId: 'ch-2', message: other },
      });
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it('loadMore 以最老消息 id 为游标前插（#319 id 游标，替代 timestamp）', async () => {
    const m3 = msg('m3', { createdAt: iso(2) });
    const m4 = msg('m4', { createdAt: iso(3) });
    mockListMessages.mockResolvedValue({ data: { data: [m3, m4], hasMore: true } });
    const { result } = renderHook(() => useChannelMessages('ch-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    const m1 = msg('m1', { createdAt: iso(0) });
    const m2 = msg('m2', { createdAt: iso(1) });
    mockListMessages.mockResolvedValue({ data: { data: [m1, m2], hasMore: false } });

    let inserted: boolean | undefined;
    await act(async () => {
      inserted = await result.current.loadMore();
    });

    expect(mockListMessages).toHaveBeenLastCalledWith('ch-1', { before: 'm3' });
    expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(result.current.hasMore).toBe(false);
    expect(inserted).toBe(true);
  });
});

// #313：轮询已收敛 useGatedPoll，本 describe 钉消费方接线
// （SSE connected 不发周期请求 / SSE 断开 10s 兜底 / 频道切换立即重拉）
describe('useChannelMessages（#313 门禁轮询接线）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCtx.status = 'connected';
    mockOnEvent.mockReturnValue(() => {});
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushFirstFetch() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('SSE connected 时仅挂载首拉，fake timers 推进不发周期请求', async () => {
    renderHook(() => useChannelMessages('ch-1'));
    await flushFirstFetch();
    expect(mockListMessages).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(mockListMessages).toHaveBeenCalledTimes(1);
  });

  it('SSE 断开时 10s 兜底轮询', async () => {
    mockCtx.status = 'disconnected';
    renderHook(() => useChannelMessages('ch-1'));
    await flushFirstFetch();
    expect(mockListMessages).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(mockListMessages).toHaveBeenCalledTimes(2);
  });

  it('频道切换立即重拉（不重复首拉）', async () => {
    const { rerender } = renderHook(({ id }) => useChannelMessages(id), { initialProps: { id: 'ch-1' } });
    await flushFirstFetch();
    expect(mockListMessages).toHaveBeenCalledTimes(1);
    rerender({ id: 'ch-2' });
    await flushFirstFetch();
    expect(mockListMessages).toHaveBeenCalledTimes(2);
    expect(mockListMessages).toHaveBeenLastCalledWith('ch-2');
  });
});
