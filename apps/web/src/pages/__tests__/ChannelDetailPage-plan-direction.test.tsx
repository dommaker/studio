// ChannelDetailPage — #567：plan_direction 方向锁定接力卡跳轉
// 契约：卡片「去选定」→ WorkUnitDrawer 收到 { kind:'wu', id, autoDirection: true }（打开即弹 PlanDirectionDialog）
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

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: () => () => {}, onReconnect: () => () => {} }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => null }));
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
    id: 'msg-pd-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'Planner',
    content: '需要输入: 方向锁定——请选定本票方向', workUnitId: 'wu-plan-1', replyToId: null,
    meta: JSON.stringify({ cardType: 'plan_direction' }),
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

describe('ChannelDetailPage — #567 plan_direction 方向锁定接力卡', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
  });

  it('plan_direction 卡渲染「方向待锁定」+「去选定」按钮', async () => {
    renderPage();
    expect(await screen.findByText('方向待锁定')).toBeTruthy();
    expect(screen.getByText('去选定')).toBeTruthy();
  });

  it('点「去选定」→ WorkUnitDrawer 收到 { kind: wu, id, autoDirection: true }（打开即弹）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('去选定'));

    await waitFor(() => {
      const last = mockDrawerProps.mock.calls.at(-1)?.[0] as { drawer?: unknown };
      expect(last?.drawer).toEqual({ kind: 'wu', id: 'wu-plan-1', autoDirection: true });
    });
  });
});
