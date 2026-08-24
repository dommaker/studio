// useChannelMessages — #287（清单 P2 #19）：去重 / 有序归组 / 孤儿归并
// 核心不变式：messages 恒按 createdAt 升序——下游 groupIntoThreads 单遍归组
// 要求 anchor 先于 reply 出现，增量到达（SSE/轮询/发送）不得破坏该顺序，
// 否则同一线程回复在刷新前后出现两种位置（走查 F17）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import type { WebSocketMessage } from '../../api/websocketHooks';

const { mockListMessages, mockSendMessage, mockOnEvent } = vi.hoisted(() => ({
  mockListMessages: vi.fn(),
  mockSendMessage: vi.fn(),
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listMessages: mockListMessages, sendMessage: mockSendMessage },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, status: 'connected' }),
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
});
