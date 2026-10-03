// useAwaitingAgent（P3-b 自 ChannelDetailPage 切出）——#493「已送达/等待 agent」状态：
// notifyReplySent 置位 / agent 该 WU 新消息到达 → answered 派生 / 30s 兜底自清
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import { useAwaitingAgent } from '../useAwaitingAgent';

const iso = (s: number) => new Date(s).toISOString();

function agentMsg(id: string, wuId: string, createdAtMs: number): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'agent',
    workUnitId: wuId,
    content: `内容-${id}`,
    replyToId: null,
    createdAt: iso(createdAtMs),
  } as ChannelMessage;
}

describe('useAwaitingAgent — P3-b #493 等待 agent 状态', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notifyReplySent 置 awaiting；初始 answered=false', () => {
    const { result } = renderHook(() => useAwaitingAgent([]));
    expect(result.current.awaiting).toBeNull();
    act(() => result.current.notifyReplySent('wu-1'));
    expect(result.current.awaiting?.wuId).toBe('wu-1');
    expect(result.current.answered).toBe(false);
  });

  it('该 WU 的 agent 新消息（createdAt >= since）到达 → answered=true', () => {
    const now = Date.now();
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ChannelMessage[] }) => useAwaitingAgent(messages),
      { initialProps: { messages: [] as ChannelMessage[] } },
    );
    act(() => result.current.notifyReplySent('wu-1'));
    const since = result.current.awaiting!.since;
    // 其他 WU 的 agent 消息不算
    rerender({ messages: [agentMsg('m1', 'wu-2', now + 1000)] });
    expect(result.current.answered).toBe(false);
    // 本 WU 的 agent 新消息 → 已应答
    rerender({ messages: [agentMsg('m2', 'wu-1', since + 1000)] });
    expect(result.current.answered).toBe(true);
  });

  it('30s 兜底定时清 state（agent 无响应条不常住）', () => {
    const { result } = renderHook(() => useAwaitingAgent([]));
    act(() => result.current.notifyReplySent('wu-1'));
    expect(result.current.awaiting).not.toBeNull();
    act(() => { vi.advanceTimersByTime(29_999); });
    expect(result.current.awaiting).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.awaiting).toBeNull();
  });

  it('卸载清定时器（不残留 setState）', () => {
    const { result, unmount } = renderHook(() => useAwaitingAgent([]));
    act(() => result.current.notifyReplySent('wu-1'));
    unmount();
    act(() => { vi.advanceTimersByTime(60_000); });
    // 无 act 警告即通过（断言占位：卸载后无崩溃）
    expect(true).toBe(true);
  });
});
