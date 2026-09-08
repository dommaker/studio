// useUnreadStoreSync — unreadStore 的 SSE 接线单测：引用计数单例（多消费方只注册一次、
// 最后一个卸载才退订）+ channel.message_sent 路由进 store action。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent } = vi.hoisted(() => ({ mockOnEvent: vi.fn() }));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

import { useUnreadStoreSync } from '../useUnreadStoreSync';
import { useUnreadStore } from '../../stores/unreadStore';

beforeEach(() => {
  mockOnEvent.mockReset();
  useUnreadStore.setState({ unreadCounts: {}, activeChannelId: null });
});

describe('useUnreadStoreSync', () => {
  it('多消费方同时挂载只注册一次订阅（引用计数单例）', () => {
    mockOnEvent.mockReturnValue(() => {});
    const a = renderHook(() => useUnreadStoreSync());
    const b = renderHook(() => useUnreadStoreSync());
    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it('最后一个消费方卸载才退订，重挂恢复订阅', () => {
    const unsub = vi.fn();
    mockOnEvent.mockReturnValue(unsub);

    const a = renderHook(() => useUnreadStoreSync());
    const b = renderHook(() => useUnreadStoreSync());
    a.unmount();
    expect(unsub).not.toHaveBeenCalled();
    b.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);

    renderHook(() => useUnreadStoreSync());
    expect(mockOnEvent).toHaveBeenCalledTimes(2);
  });

  it('channel.message_sent（非人类）路由进 store 计数', () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });

    renderHook(() => useUnreadStoreSync());
    act(() => {
      handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1', message: { authorType: 'agent' } } });
    });
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBe(1);
  });

  it('人类消息与其他事件类型不路由', () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });

    renderHook(() => useUnreadStoreSync());
    act(() => {
      handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1', message: { authorType: 'human' } } });
      handler!({ event_type: 'channel.message_updated', data: { channelId: 'ch-1' } });
      handler!({ event_type: 'channel.message_sent', data: {} });
    });
    expect(useUnreadStore.getState().unreadCounts).toEqual({});
  });
});
