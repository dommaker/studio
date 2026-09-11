// useChannelMessages — #486 乐观回显：发送即插 pending 本地消息（不等 REST 往返），
// 成功后服务端本体原位替换（SSE 先到时按 id 去重同样收敛不重复），失败回滚 + 上抛；
// pending 不参与分页游标（本地 id 服务端不存在，作 before 锚点会翻出空页）。
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

function serverMsg(id: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'human',
    content: '你好',
    replyToId: null,
    workUnitId: null,
    meta: '{}',
    createdAt: iso(10),
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

describe('useChannelMessages — 乐观回显（#486）', () => {
  let handler: (msg: WebSocketMessage) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
    mockOnEvent.mockImplementation((h: (msg: WebSocketMessage) => void) => {
      handler = h;
      return () => {};
    });
  });

  async function renderLoaded() {
    const { result } = renderHook(() => useChannelMessages('ch-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    return result;
  }

  it('发送即乐观插入 pending 消息（不等 REST 往返）', async () => {
    const result = await renderLoaded();
    let resolveSend!: (v: unknown) => void;
    mockSendMessage.mockImplementation(() => new Promise(resolve => { resolveSend = resolve; }));

    let sendPromise!: Promise<unknown>;
    act(() => { sendPromise = result.current.sendMessage('你好'); });

    // REST 未返回，pending 已在流内
    const pending = result.current.messages.find(m => m.pending);
    expect(pending).toBeTruthy();
    expect(pending!.id).toMatch(/^pending-/);
    expect(pending!.content).toBe('你好');
    expect(pending!.authorType).toBe('human');

    await act(async () => {
      resolveSend({ data: { data: serverMsg('s1') } });
      await sendPromise;
    });
  });

  it('成功后 pending 被服务端本体原位替换（无 pending 残留）', async () => {
    const result = await renderLoaded();
    mockSendMessage.mockResolvedValue({ data: { data: serverMsg('s1') } });

    await act(async () => {
      await result.current.sendMessage('你好');
    });

    expect(result.current.messages.some(m => m.pending)).toBe(false);
    expect(result.current.messages.filter(m => m.id === 's1')).toHaveLength(1);
  });

  it('SSE 先于 REST 到达：替换后仍只留一份服务端本体（id 去重不重复）', async () => {
    const result = await renderLoaded();
    const sent = serverMsg('s1');
    let resolveSend!: (v: unknown) => void;
    mockSendMessage.mockImplementation(() => new Promise(resolve => { resolveSend = resolve; }));

    let sendPromise!: Promise<unknown>;
    act(() => { sendPromise = result.current.sendMessage('你好'); });
    // SSE 回声先到：服务端本体按 id 插入，pending 仍在
    act(() => handler(sseMessage(sent)));
    expect(result.current.messages.some(m => m.pending)).toBe(true);

    await act(async () => {
      resolveSend({ data: { data: sent } });
      await sendPromise;
    });

    expect(result.current.messages.some(m => m.pending)).toBe(false);
    expect(result.current.messages.filter(m => m.id === 's1')).toHaveLength(1);
  });

  it('失败回滚 pending + promise 上抛（调用方回灌草稿）', async () => {
    const result = await renderLoaded();
    mockSendMessage.mockRejectedValue(new Error('network down'));

    await act(async () => {
      await expect(result.current.sendMessage('你好')).rejects.toThrow('network down');
    });

    expect(result.current.messages.some(m => m.pending)).toBe(false);
    expect(result.current.messages).toHaveLength(0);
  });

  it('pending 不作分页游标：列表仅 pending 时 loadMore 不发请求', async () => {
    // 边界：首拉空页但 hasMore=true（服务端分页边缘），随后本地 pending 成为唯一消息
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: true } });
    const result = await renderLoaded();
    let resolveSend!: (v: unknown) => void;
    mockSendMessage.mockImplementation(() => new Promise(resolve => { resolveSend = resolve; }));

    let sendPromise!: Promise<unknown>;
    act(() => { sendPromise = result.current.sendMessage('你好'); });
    expect(result.current.messages.some(m => m.pending)).toBe(true);

    let inserted: boolean | undefined;
    await act(async () => {
      inserted = await result.current.loadMore();
    });

    expect(inserted).toBe(false);
    // 仅首拉一次——不得拿 pending-<本地id> 当 before 锚点发请求
    expect(mockListMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend({ data: { data: serverMsg('s1') } });
      await sendPromise;
    });
  });
});
