// #520 测量②：频道页 jsdom 组件测试——埋点②（回执 SSE 到达→渲染完成）与
// 埋点③（进页→首屏消息渲染完成）的时机断言；sink 关闭时页面行为不变。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockApiGet, mockSink } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockSink: vi.fn(),
}));

vi.mock('../../api', () => ({ api: { get: mockApiGet, post: vi.fn() } }));

let currentMessages: ChannelMessage[] = [];
vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    error: null,
    hasMore: false,
    sendMessage: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
    syncPruning: vi.fn(),
  }),
}));

vi.mock('../../api/workunit', () => ({ workunitApi: { list: vi.fn().mockResolvedValue({ data: { data: [] } }) } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: vi.fn().mockResolvedValue({ data: { data: [] } }), get: vi.fn() } }));
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }),
}));
vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div /> }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import type { ChannelMessage } from '../../api/channel';
import { setClientPerfSink, resetClientPerfSink, markReceiptArrived } from '../../utils/clientPerf';

const iso = (s: number) => new Date(s * 1000).toISOString();

function msg(id: string, seq: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
    content: `正文-${id}`, createdAt: iso(seq), ...over,
  };
}

const tree = () => (
  <MemoryRouter initialEntries={['/channels/ch-1']}>
    <Routes>
      <Route path="/channels/:id" element={<ChannelDetailPage />} />
    </Routes>
  </MemoryRouter>
);

const eventsOf = (type: string) =>
  mockSink.mock.calls.filter(c => c[0] === type).map(c => c[1]);

describe('ChannelDetailPage — #520 页面加载/回执渲染埋点时机', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientPerfSink();
    setClientPerfSink(mockSink);
    currentMessages = [msg('t-1', 1, { workUnitId: 'WU-1' })];
    mockApiGet.mockResolvedValue({ data: { data: null } });
  });

  it('③ 进页且首屏消息渲染完成 → 发 client.perf.page_load（channelId + 耗时），仅一次', async () => {
    const { rerender } = render(tree());
    await waitFor(() => expect(eventsOf('client.perf.page_load')).toHaveLength(1));
    expect(eventsOf('client.perf.page_load')[0].channelId).toBe('ch-1');
    expect(typeof eventsOf('client.perf.page_load')[0].ms).toBe('number');

    // 消息流后续更新（新消息到达）不重发 page_load
    currentMessages = [...currentMessages, msg('t-2', 2)];
    rerender(tree());
    await waitFor(() => expect(document.querySelector('[data-message-id="t-2"]')).toBeTruthy());
    expect(eventsOf('client.perf.page_load')).toHaveLength(1);
  });

  it('② SSE 标记过的消息渲染完成 → 发 client.perf.receipt_render（messageId/workUnitId/ms）', async () => {
    const { rerender } = render(tree());
    await waitFor(() => expect(eventsOf('client.perf.page_load')).toHaveLength(1));
    // 首拉消息无 SSE 标记 → 不发 receipt_render
    expect(eventsOf('client.perf.receipt_render')).toHaveLength(0);

    // SSE 到达（hook 记起点）→ 消息进列表渲染完成
    markReceiptArrived('a-9');
    currentMessages = [...currentMessages, msg('a-9', 2, { workUnitId: 'WU-1' })];
    rerender(tree());

    await waitFor(() => expect(eventsOf('client.perf.receipt_render')).toHaveLength(1));
    const payload = eventsOf('client.perf.receipt_render')[0];
    expect(payload).toMatchObject({ channelId: 'ch-1', messageId: 'a-9', workUnitId: 'WU-1' });
    expect(typeof payload.ms).toBe('number');
  });

  it('sink 关闭时页面正常渲染、零事件', async () => {
    setClientPerfSink(null);
    render(tree());
    await waitFor(() => expect(document.querySelector('[data-message-id="t-1"]')).toBeTruthy());
    expect(mockSink).not.toHaveBeenCalled();
  });
});
