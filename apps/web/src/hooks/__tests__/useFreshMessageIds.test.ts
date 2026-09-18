// useFreshMessageIds（#548 自 ChannelDetailPage 迁出）：
// SSE 新到达消息 id 集 + 2s 定时清除（批次 E-3 渐隐高亮口径）——
// 全部新到达消息（含自己发送的回显）；首拉与翻页 prepend/水合归并的历史不标
// （createdAt 早于到达前最新一条即历史）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import { useFreshMessageIds } from '../useFreshMessageIds';

const iso = (s: number) => new Date(s * 1000).toISOString();

function msg(id: string, seq: number): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'agent',
    content: `内容-${id}`,
    replyToId: null,
    createdAt: iso(seq),
  };
}

describe('useFreshMessageIds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('首载：全部记为已见，不高亮', () => {
    const { result } = renderHook(({ msgs }) => useFreshMessageIds(msgs), {
      initialProps: { msgs: [msg('m1', 0), msg('m2', 1)] },
    });
    expect(result.current.size).toBe(0);
  });

  it('新到消息（createdAt ≥ 已见最新）→ 进 fresh 集', () => {
    const { result, rerender } = renderHook(({ msgs }) => useFreshMessageIds(msgs), {
      initialProps: { msgs: [msg('m1', 0)] },
    });
    rerender({ msgs: [msg('m1', 0), msg('m2', 1), msg('m3', 2)] });
    expect([...result.current].sort()).toEqual(['m2', 'm3']);
  });

  it('翻页 prepend / 水合归并的历史（createdAt 早于已见最新）→ 不标', () => {
    const { result, rerender } = renderHook(({ msgs }) => useFreshMessageIds(msgs), {
      initialProps: { msgs: [msg('m3', 2)] },
    });
    rerender({ msgs: [msg('m1', 0), msg('m2', 1), msg('m3', 2)] });
    expect(result.current.size).toBe(0);
  });

  it('2s 后清除（经基类过渡渐隐）', () => {
    const { result, rerender } = renderHook(({ msgs }) => useFreshMessageIds(msgs), {
      initialProps: { msgs: [msg('m1', 0)] },
    });
    rerender({ msgs: [msg('m1', 0), msg('m2', 1)] });
    expect(result.current.has('m2')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.size).toBe(0);
  });

  // #549：per-id 语义（机制 = utils/freshIds 共享件）——各自到达起 2s 渐隐，互不重计时
  it('清除窗口内又有新到 → per-id 各自计时：先到的先清，后到的留', () => {
    const { result, rerender } = renderHook(({ msgs }) => useFreshMessageIds(msgs), {
      initialProps: { msgs: [msg('m1', 0)] },
    });
    rerender({ msgs: [msg('m1', 0), msg('m2', 1)] });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ msgs: [msg('m1', 0), msg('m2', 1), msg('m3', 2)] });
    act(() => {
      vi.advanceTimersByTime(1000); // m2 到自己的 2s
    });
    expect(result.current.has('m2')).toBe(false); // 先到先清（不受 m3 到达影响）
    expect(result.current.has('m3')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.size).toBe(0);
  });
});
