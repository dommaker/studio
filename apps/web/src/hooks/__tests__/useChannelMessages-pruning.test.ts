// useChannelMessages 数据层降级接线（#326，ADR 2026-08-25）：
// syncPruning(anchorMid) 按 planPrune 判定降级上方历史；视口进入降级区时防抖整页水合
// （mergePage 归并复活骨架，不触碰 hasMore——prepend 方向状态归 loadMore 独有）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { degradeMessage } from '../../utils/messagePruning';

// 小参数便于构造场景：K=3、D1=2、D2=1
const PRUNE_OPTS = { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 };

const iso = (s: number) => new Date(s * 1000).toISOString();

function msg(id: string, seq: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'agent',
    content: `内容-${id}`,
    createdAt: iso(seq),
    ...over,
  };
}

function batch(n: number): ChannelMessage[] {
  return Array.from({ length: n }, (_, i) => msg(`m${i + 1}`, i + 1));
}

describe('useChannelMessages 降级/水合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
    mockOnEvent.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderLoaded(initial: ChannelMessage[], hasMore = false) {
    mockListMessages.mockResolvedValue({ data: { data: initial, hasMore } });
    const { result } = renderHook(() => useChannelMessages('ch-1', { prune: PRUNE_OPTS }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loading).toBe(false);
    return result;
  }

  it('syncPruning 降级视口上方超过 D1 的消息为骨架', async () => {
    const list = batch(10);
    const result = await renderLoaded(list);
    act(() => result.current.syncPruning('m8')); // idx 7：边界 7-2=5 → [m1..m5] 降级
    const msgs = result.current.messages;
    expect(msgs.slice(0, 5).every(m => m.degraded && m.content === '')).toBe(true);
    expect(msgs.slice(5).every(m => !m.degraded && m.content !== '')).toBe(true);
    // 结构字段全留
    expect(msgs[0].id).toBe('m1');
    expect(msgs[0].createdAt).toBe(list[0].createdAt);
  });

  it('尾部 K 条保底：anchor 在末尾时仍只降到 len-K', async () => {
    const result = await renderLoaded(batch(6));
    act(() => result.current.syncPruning('m6')); // 边界 min(6-1-2, 6-3)=3 → [m1..m3]
    expect(result.current.messages.map(m => !!m.degraded)).toEqual([true, true, true, false, false, false]);
  });

  it('视口进入降级区 → 防抖后以首个非骨架 id 为 before 游标整页水合，骨架原位复活', async () => {
    const list = batch(10);
    const result = await renderLoaded(list);
    // 先降级 [m1..m5]
    act(() => result.current.syncPruning('m8'));
    // 水合页 = m1..m5 全量本体
    mockListMessages.mockResolvedValue({ data: { data: list.slice(0, 5), hasMore: true } });
    // anchor 移到边界（m6，idx 5 < 5+1）→ 触发水合
    act(() => result.current.syncPruning('m6'));
    expect(mockListMessages).toHaveBeenCalledTimes(1); // 首拉；防抖未触发
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(mockListMessages).toHaveBeenCalledWith('ch-1', { before: 'm6', limit: 100 });
    expect(result.current.messages.every(m => !m.degraded)).toBe(true);
    expect(result.current.messages.map(m => m.id)).toEqual(list.map(m => m.id));
  });

  it('水合不触碰 hasMore（prepend 方向状态归 loadMore）', async () => {
    const result = await renderLoaded(batch(10), true);
    act(() => result.current.syncPruning('m8'));
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
    act(() => result.current.syncPruning('m6'));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(result.current.hasMore).toBe(true);
  });

  it('防抖窗口内连续 syncPruning 只发一次水合请求（最新游标生效）', async () => {
    const result = await renderLoaded(batch(10));
    act(() => result.current.syncPruning('m8'));
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
    act(() => {
      result.current.syncPruning('m6');
      result.current.syncPruning('m6');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const hydrateCalls = mockListMessages.mock.calls.filter(c => c[1]?.before === 'm6');
    expect(hydrateCalls).toHaveLength(1);
  });

  it('视口远离降级区时不水合', async () => {
    const result = await renderLoaded(batch(10));
    act(() => result.current.syncPruning('m8'));
    mockListMessages.mockClear();
    act(() => result.current.syncPruning('m9')); // idx 8 >= 5+1
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(mockListMessages).not.toHaveBeenCalled();
  });

  it('legacy message_updated patch 命中骨架 → 原位复活并清 degraded 标记', async () => {
    let handler: (m: WebSocketMessage) => void = () => {};
    mockOnEvent.mockImplementation((h: (m: WebSocketMessage) => void) => { handler = h; return () => {}; });
    const list = batch(10);
    const result = await renderLoaded(list);
    act(() => result.current.syncPruning('m8'));
    expect(result.current.messages[0].degraded).toBe(true);
    act(() => handler({
      event_id: 'ev-1',
      event_type: 'channel.message_updated',
      timestamp: iso(1),
      data: { channelId: 'ch-1', messageId: 'm1', content: '更新后', meta: { status: 'done' } },
    }));
    const m1 = result.current.messages[0];
    expect(m1.content).toBe('更新后');
    expect(m1.degraded).toBe(false);
  });

  it('degradeMessage 保留 meta status/cardType（折叠计数/合并判定输入）', () => {
    const s = degradeMessage(msg('x', 1, { meta: { status: 'done', cardType: 'wu_card', cardData: { a: 1 } } }));
    expect(s.meta).toEqual({ status: 'done', cardType: 'wu_card' });
  });
});
