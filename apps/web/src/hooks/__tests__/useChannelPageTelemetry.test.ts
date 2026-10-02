// useChannelPageTelemetry（P3-b 自 ChannelDetailPage 切出）——#393 最近频道 + #520 埋点链：
// 进页 saveLastChannelId + markPageEntry；首屏渲染完成 emitPageFirstRender（空频道/加载中不发）；
// receipt_render 仅 freshMsgIds（SSE 新到达集）命中消息发事件
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockSaveLast, mockMarkEntry, mockFirstRender, mockReceipt } = vi.hoisted(() => ({
  mockSaveLast: vi.fn(),
  mockMarkEntry: vi.fn(),
  mockFirstRender: vi.fn(),
  mockReceipt: vi.fn(),
}));

vi.mock('../../utils/lastChannel', () => ({ saveLastChannelId: mockSaveLast }));
vi.mock('../../utils/clientPerf', () => ({
  markPageEntry: mockMarkEntry,
  emitPageFirstRender: mockFirstRender,
  emitReceiptRendered: mockReceipt,
}));

import type { ChannelMessage } from '../../api/channel';
import { useChannelPageTelemetry } from '../useChannelPageTelemetry';

const msg = (id: string, wuId?: string) => ({
  id, channelId: 'ch-1', authorType: 'agent', content: id, replyToId: null,
  createdAt: '2026-10-01T00:00:00Z', workUnitId: wuId ?? null,
} as ChannelMessage);

describe('useChannelPageTelemetry — P3-b 频道页埋点', () => {
  beforeEach(() => vi.clearAllMocks());

  it('进页记最近频道 + 埋点起点；id 缺省不发', () => {
    const { unmount } = renderHook(() => useChannelPageTelemetry('ch-1', [], true, new Set()));
    expect(mockSaveLast).toHaveBeenCalledWith('ch-1');
    expect(mockMarkEntry).toHaveBeenCalledWith('ch-1');
    unmount();
    vi.clearAllMocks();
    renderHook(() => useChannelPageTelemetry(undefined, [], true, new Set()));
    expect(mockSaveLast).not.toHaveBeenCalled();
    expect(mockMarkEntry).not.toHaveBeenCalled();
  });

  it('首屏渲染完成发 emitPageFirstRender；加载中/空频道不发', () => {
    const { rerender } = renderHook(
      ({ messages, loading }: { messages: ChannelMessage[]; loading: boolean }) =>
        useChannelPageTelemetry('ch-1', messages, loading, new Set()),
      { initialProps: { messages: [] as ChannelMessage[], loading: true } },
    );
    expect(mockFirstRender).not.toHaveBeenCalled(); // 加载中不发
    rerender({ messages: [], loading: false });
    expect(mockFirstRender).not.toHaveBeenCalled(); // 空频道不发
    rerender({ messages: [msg('m1')], loading: false });
    expect(mockFirstRender).toHaveBeenCalledWith('ch-1');
  });

  it('receipt_render 仅 freshMsgIds 命中的消息发事件（历史消息天然跳过）', () => {
    renderHook(() =>
      useChannelPageTelemetry('ch-1', [msg('m1', 'wu-1'), msg('m2')], false, new Set(['m2'])),
    );
    expect(mockReceipt).toHaveBeenCalledTimes(1);
    expect(mockReceipt).toHaveBeenCalledWith({ messageId: 'm2', channelId: 'ch-1', workUnitId: null });
  });
});
