// useWorkUnitEvents — workunit SSE 事件订阅（防抖回调）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api/websocket', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

import { useWorkUnitEvents } from '../useWorkUnitEvents';

describe('useWorkUnitEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockOnEvent.mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('workunit.created / workunit.status_changed 触发回调（防抖窗口内多次合并为一次）', () => {
    let handler: ((msg: any) => void) | null = null;
    mockOnEvent.mockImplementation((h: any) => { handler = h; return () => {}; });
    const onChange = vi.fn();
    renderHook(() => useWorkUnitEvents(onChange));

    act(() => {
      handler!({ event_type: 'workunit.created', data: {} });
      handler!({ event_type: 'workunit.status_changed', data: {} });
      handler!({ event_type: 'workunit.status_changed', data: {} });
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(400); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('忽略非 workunit 事件类型', () => {
    let handler: ((msg: any) => void) | null = null;
    mockOnEvent.mockImplementation((h: any) => { handler = h; return () => {}; });
    const onChange = vi.fn();
    renderHook(() => useWorkUnitEvents(onChange));

    act(() => {
      handler!({ event_type: 'channel.message_sent', data: {} });
      handler!({ event_type: 'agent.health.failed', data: {} });
    });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('unmount 时退订并清掉未触发的防抖计时器', () => {
    const unsub = vi.fn();
    let handler: ((msg: any) => void) | null = null;
    mockOnEvent.mockImplementation((h: any) => { handler = h; return unsub; });
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useWorkUnitEvents(onChange));

    act(() => {
      handler!({ event_type: 'workunit.created', data: {} });
    });
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('回调引用随渲染更新（不闭包旧回调）', () => {
    let handler: ((msg: any) => void) | null = null;
    mockOnEvent.mockImplementation((h: any) => { handler = h; return () => {}; });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useWorkUnitEvents(cb), { initialProps: { cb: first } });

    rerender({ cb: second });
    act(() => {
      handler!({ event_type: 'workunit.status_changed', data: {} });
    });
    act(() => { vi.advanceTimersByTime(400); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
