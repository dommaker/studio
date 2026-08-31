// useDataPlaneSync 单测 — #403 数据面接线底座（ADR 2026-08-31 决策 6）的契约钉子。
// useRosterStoreSync 迁移其上（其套件保留为 roster 参数下的集成验证）；此文件用替身直接锁定：
// 引用计数单例（多挂载不放大订阅、全部卸载才退订）/ 重连强刷（maxAgeMs 0）/ 门禁轮询。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockOnReconnect, mockCtx } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockCtx: { status: 'disconnected' as string },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect, status: mockCtx.status }),
}));

import { useDataPlaneSync, type DataPlaneSyncOptions } from '../useDataPlaneSync';

function makeOptions() {
  const handleEvent = vi.fn();
  const ensureFresh = vi.fn().mockResolvedValue(undefined);
  return { handleEvent, ensureFresh, options: { handleEvent, ensureFresh, pollIntervalMs: 30000 } as DataPlaneSyncOptions };
}

async function flush() {
  await act(async () => {});
}

describe('useDataPlaneSync — 引用计数 / 重连 / 轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCtx.status = 'disconnected';
    mockOnEvent.mockReturnValue(() => {});
    mockOnReconnect.mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('多挂载只注册一条 SSE 订阅（引用计数单例），全部卸载才退订', () => {
    const { options } = makeOptions();
    const unsub = vi.fn();
    mockOnEvent.mockReturnValue(unsub);
    const a = renderHook(() => useDataPlaneSync(options));
    const b = renderHook(() => useDataPlaneSync(options));
    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(unsub).not.toHaveBeenCalled();
    b.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('SSE 重连 → ensureFresh({ maxAgeMs: 0 }) 强制对齐', async () => {
    const { options, ensureFresh } = makeOptions();
    let reconnect: (() => void) | null = null;
    mockOnReconnect.mockImplementation((h: () => void) => { reconnect = h; return () => {}; });
    renderHook(() => useDataPlaneSync(options));
    await flush();
    ensureFresh.mockClear(); // 挂载首拉（useGatedPoll）不算重连对齐
    act(() => { reconnect!(); });
    await flush();
    expect(ensureFresh).toHaveBeenCalledWith({ maxAgeMs: 0 });
  });

  it('兜底轮询：SSE 断开且 visible 时挂载首拉 + 到点轮询（ensureFresh 无参 = 走 TTL）', async () => {
    const { options, ensureFresh } = makeOptions();
    renderHook(() => useDataPlaneSync(options));
    await flush();
    expect(ensureFresh).toHaveBeenCalledWith(); // 挂载首拉
    ensureFresh.mockClear();
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('SSE connected 时不起轮询计时器（useGatedPoll 门禁透传）', async () => {
    mockCtx.status = 'connected';
    const { options, ensureFresh } = makeOptions();
    renderHook(() => useDataPlaneSync(options));
    await flush();
    ensureFresh.mockClear();
    await act(async () => { vi.advanceTimersByTime(90000); });
    expect(ensureFresh).not.toHaveBeenCalled();
  });
});
