// #520 测量②：useChannelMessages SSE 到达即记回执渲染计时起点——
// 新消息（未在列表）到达标记起点；已在列表的 SSE 回声不记（其渲染由 REST 替换完成，非本次到达）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import type { WebSocketMessage } from '../../api/websocketHooks';

const { mockListMessages, mockOnEvent, mockSink } = vi.hoisted(() => ({
  mockListMessages: vi.fn(),
  mockOnEvent: vi.fn(),
  mockSink: vi.fn(),
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listMessages: mockListMessages, sendMessage: vi.fn() },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, status: 'connected' }),
}));

import { useChannelMessages } from '../useChannelEvents';
import { setClientPerfSink, resetClientPerfSink, emitReceiptRendered } from '../../utils/clientPerf';

function msg(id: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id, channelId: 'ch-1', authorType: 'agent', content: `内容-${id}`,
    replyToId: null, workUnitId: null, meta: '{}',
    createdAt: new Date(1000).toISOString(), ...over,
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

describe('useChannelMessages — #520 回执渲染计时起点', () => {
  let handler: (msg: WebSocketMessage) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    resetClientPerfSink();
    setClientPerfSink(mockSink);
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

  it('SSE 新消息到达 → 标记起点（渲染完成可配对出 receipt_render 事件）', async () => {
    await renderLoaded([]);
    act(() => handler(sseMessage(msg('m-1', { workUnitId: 'WU-1' }))));

    emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: 'WU-1' });
    expect(mockSink).toHaveBeenCalledTimes(1);
    expect(mockSink.mock.calls[0][0]).toBe('client.perf.receipt_render');
    expect(mockSink.mock.calls[0][1]).toMatchObject({ messageId: 'm-1', channelId: 'ch-1', workUnitId: 'WU-1' });
    expect(typeof mockSink.mock.calls[0][1].ms).toBe('number');
  });

  it('已在列表的消息的 SSE 回声 → 不标记（后续渲染不发事件）', async () => {
    const m1 = msg('m-1');
    await renderLoaded([m1]);
    act(() => handler(sseMessage(m1))); // 回声：id 已存在

    emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: null });
    expect(mockSink).not.toHaveBeenCalled();
  });

  it('sink 关闭时 SSE 到达不标记、不抛错', async () => {
    setClientPerfSink(null);
    const result = await renderLoaded([]);
    act(() => handler(sseMessage(msg('m-2'))));
    expect(result.current.messages.map(m => m.id)).toEqual(['m-2']);

    setClientPerfSink(mockSink);
    emitReceiptRendered({ messageId: 'm-2', channelId: 'ch-1', workUnitId: null });
    expect(mockSink).not.toHaveBeenCalled();
  });
});
