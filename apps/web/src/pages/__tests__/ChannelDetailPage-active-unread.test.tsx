// ChannelDetailPage — #413「正在看」语义：页面挂载写入 unreadStore.activeChannelId（进频道
// 即清零该频道未读，active 频道不涨徽章），卸载/切走回 null。断点跨越行为见 ChannelDetailPage-narrow。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockOnEvent, mockOnReconnect } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: [],
    loading: false,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    syncPruning: vi.fn(),
  }),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockListWorkunits },
}));

vi.mock('../../api/requirements', () => ({
  requirementApi: { list: mockListReqs, get: vi.fn() },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({
  ChannelRail: () => <div data-testid="channel-rail" />,
}));
vi.mock('../../components/channel/ChannelActivityRail', () => ({
  ChannelActivityRail: () => <div data-testid="activity-rail" />,
}));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: () => null,
}));
vi.mock('../../components/channel/ChannelMemberManager', () => ({
  ChannelMemberManager: () => <div data-testid="member-manager" />,
}));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({
  ChannelDefaultProjectSelect: () => <div data-testid="default-project-select" />,
}));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({
  ChannelCurrentPmoChip: () => <div data-testid="current-pmo-chip" />,
}));
vi.mock('../../components/channel/ChannelInput', () => ({
  ChannelInput: () => <div data-testid="channel-input" />,
}));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useUnreadStore } from '../../stores/unreadStore';

const renderPage = (channelId = 'ch-1') =>
  render(
    <MemoryRouter initialEntries={[`/channels/${channelId}`]}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

function NavButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button data-testid={`nav-${to.split('/').pop()}`} onClick={() => navigate(to)} />; // 模拟站内跳转
}

describe('ChannelDetailPage — #413 active 频道写入 unreadStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUnreadStore.setState({ unreadCounts: {}, activeChannelId: null });
    mockApiPost.mockResolvedValue({ data: { success: true } });
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockOnReconnect.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
  });

  it('挂载写入 activeChannelId 并清零该频道既有未读（打开即读）', () => {
    useUnreadStore.setState({ unreadCounts: { 'ch-1': 3 } });
    renderPage('ch-1');
    expect(screen.getByTestId('channel-rail')).toBeInTheDocument();
    const state = useUnreadStore.getState();
    expect(state.activeChannelId).toBe('ch-1');
    expect(state.unreadCounts['ch-1']).toBeUndefined();
  });

  it('卸载回 null，此后消息恢复累加语义', () => {
    const { unmount } = renderPage('ch-1');
    expect(useUnreadStore.getState().activeChannelId).toBe('ch-1');
    unmount();
    expect(useUnreadStore.getState().activeChannelId).toBeNull();
  });

  it('路由切频道（ch-1 → ch-2）active 跟随并清零新频道计数', () => {
    useUnreadStore.setState({ unreadCounts: { 'ch-2': 5 } });
    render(
      <MemoryRouter initialEntries={['/channels/ch-1']}>
        <NavButton to="/channels/ch-2" />
        <Routes>
          <Route path="/channels/:id" element={<ChannelDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(useUnreadStore.getState().activeChannelId).toBe('ch-1');

    fireEvent.click(screen.getByTestId('nav-ch-2'));
    const state = useUnreadStore.getState();
    expect(state.activeChannelId).toBe('ch-2');
    expect(state.unreadCounts['ch-2']).toBeUndefined();
  });
});
