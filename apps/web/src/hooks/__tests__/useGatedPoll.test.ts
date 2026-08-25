// useGatedPoll — 共享门禁轮询（#313）：挂载首拉 + 仅当（visible ∧ SSE≠connected）按 interval 轮询 + 回 visible 立即补拉
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { ctx } = vi.hoisted(() => ({ ctx: { status: 'disconnected' as string } }));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ctx,
}));

import { useGatedPoll } from '../useGatedPoll';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** 首拉走微任务：等一拍让它落地 */
async function flushFirstFetch() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useGatedPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctx.status = 'disconnected';
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('挂载首拉一次', async () => {
    const fetch = vi.fn();
    renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('SSE connected 时不起表（推进计时器不发请求）', async () => {
    ctx.status = 'connected';
    const fetch = vi.fn();
    renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(fetch).toHaveBeenCalledTimes(1); // 仅首拉
  });

  it('SSE 断开时按 interval 轮询兜底', async () => {
    const fetch = vi.fn();
    renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('SSE 由 connected 转断开后开始轮询', async () => {
    ctx.status = 'connected';
    const fetch = vi.fn();
    const { rerender } = renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    ctx.status = 'disconnected';
    rerender();
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('hidden 时停表（SSE 断开也不轮询）', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const fetch = vi.fn();
    renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(fetch).toHaveBeenCalledTimes(1); // 仅首拉
  });

  it('回 visible 立即补拉一次并恢复计时', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const fetch = vi.fn();
    renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    setHidden(false);
    expect(fetch).toHaveBeenCalledTimes(2); // 立即补拉
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(fetch).toHaveBeenCalledTimes(3); // 计时恢复
  });

  it('unmount 时清表', async () => {
    const fetch = vi.fn();
    const { unmount } = renderHook(() => useGatedPoll(fetch, 30000));
    await flushFirstFetch();
    unmount();
    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
