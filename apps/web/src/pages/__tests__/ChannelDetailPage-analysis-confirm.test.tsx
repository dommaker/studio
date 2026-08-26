// ChannelDetailPage — #284（决策 #250 D6）：analysis_confirm 接力卡跳轉
// 契约：卡片「去确认」→ WorkUnitDrawer 收到 { kind:'wu', id, autoApprove: true }（打开即弹确认对话框）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockRefresh, mockDrawerProps } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockRefresh: vi.fn(),
  mockDrawerProps: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: vi.fn() },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: MESSAGES,
    loading: false,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: mockRefresh,
  }),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockListWorkunits },
}));

vi.mock('../../api/requirements', () => ({
  requirementApi: { list: mockListReqs },
}));

// #242：live 状态条走 WebSocketContext——测试环境无 Provider，置空订阅
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: () => () => {}, onReconnect: () => () => {} }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => null }));
// 捕获抽屉 props（接力卡跳轉断言点）
vi.mock('../../components/channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: (props: unknown) => { mockDrawerProps(props); return null; },
}));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const MESSAGES = [
  {
    id: 'msg-ac-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'Studio',
    content: '分析结论待确认（#wu-ana-1），确认后将按 TASK 拆分自动派工', workUnitId: 'wu-ana-1', replyToId: null,
    meta: JSON.stringify({ cardType: 'analysis_confirm' }),
    createdAt: new Date().toISOString(),
  },
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-sys']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — #284 analysis_confirm 接力卡', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
  });

  it('analysis_confirm 卡渲染「分析结论待确认」+「去确认」按钮', async () => {
    renderPage();
    expect(await screen.findByText('分析结论待确认')).toBeTruthy();
    expect(screen.getByText('去确认')).toBeTruthy();
  });

  it('点「去确认」→ WorkUnitDrawer 收到 { kind: wu, id, autoApprove: true }（打开即弹）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('去确认'));

    await waitFor(() => {
      const last = mockDrawerProps.mock.calls.at(-1)?.[0] as { drawer?: unknown };
      expect(last?.drawer).toEqual({ kind: 'wu', id: 'wu-ana-1', autoApprove: true });
    });
  });
});
