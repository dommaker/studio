// ChannelDetailPage 窄屏降级（#395，spec §4.6）— JS 断点行为：
// <768 左栏卸载（并入全局 Sidebar，SidebarNew.test.tsx 覆盖并入侧）；
// <1024 右栏卸载 → 顶栏「频道动态」入口开覆盖抽屉（可开可关，点 REQ/WU 联动详情抽屉并收起覆盖层）；
// ≥1024 宽屏三栏行为不变（matchMedia 缺失时回落宽屏，与存量测试同口径）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockDrawerSpy, mockOnEvent, mockOnReconnect, mockActivityRailSpy } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockDrawerSpy: vi.fn(),
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockActivityRailSpy: vi.fn(),
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
  ChannelRail: ({ activeChannelId }: { activeChannelId?: string }) => <div data-testid="channel-rail" data-active={activeChannelId} />,
}));

vi.mock('../../components/channel/ChannelActivityRail', () => ({
  ChannelActivityRail: (props: { reqs: { id: string }[]; onOpenReq: (id: string) => void; onOpenWu: (id: string) => void }) => {
    mockActivityRailSpy(props);
    return (
      <div data-testid="activity-rail">
        {props.reqs.map(r => (
          <button key={r.id} data-testid={`rail-req-${r.id}`} onClick={() => props.onOpenReq(r.id)}>{r.id}</button>
        ))}
      </div>
    );
  },
}));

vi.mock('../../components/channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: (props: { drawer: { kind: string; id: string } | null }) => {
    mockDrawerSpy(props);
    return props.drawer ? <div data-testid="wu-drawer" data-kind={props.drawer.kind} data-id={props.drawer.id} /> : null;
  },
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
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useNotificationStore } from '../../stores/notificationStore';
import { mockMatchMedia, uninstallMatchMedia } from '../../test/mockMatchMedia';

const REQS = [
  { id: 'REQ-0042', seq: 42, title: '主界面视觉方向稿', status: 'in-progress', createdAt: new Date().toISOString(), createdBy: '张弛' },
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — #395 窄屏降级', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.setState({ notifications: [] });
    mockApiPost.mockResolvedValue({ data: { success: true } });
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockOnReconnect.mockImplementation(() => () => {});
    mockListReqs.mockResolvedValue({ data: { data: REQS } });
    mockSendMessage.mockResolvedValue({});
  });

  afterEach(() => uninstallMatchMedia());

  it('宽屏（≥1024，matchMedia 缺失回落）：三栏齐挂，无覆盖抽屉', () => {
    renderPage();
    expect(screen.getByTestId('channel-rail')).toBeInTheDocument();
    expect(screen.getByTestId('activity-rail')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '频道动态' })).not.toBeInTheDocument();
  });

  it('中档（768–1023）：左栏保留、右栏卸载；顶栏「频道动态」入口开覆盖抽屉，可关', () => {
    mockMatchMedia(900);
    renderPage();
    expect(screen.getByTestId('channel-rail')).toBeInTheDocument();
    // 内联右栏不挂载（唯一实例在覆盖抽屉内，未开时零挂载）
    expect(screen.queryByTestId('activity-rail')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开频道动态' }));
    const dialog = screen.getByRole('dialog', { name: '频道动态' });
    expect(dialog).toBeInTheDocument();
    // 覆盖层内挂载频道动态右栏内容（同一份 ChannelActivityRail）
    expect(screen.getByTestId('activity-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭频道动态' }));
    expect(screen.queryByRole('dialog', { name: '频道动态' })).not.toBeInTheDocument();
  });

  it('覆盖抽屉内点 REQ：覆盖层收起 + 详情抽屉打开（不叠加两层）', () => {
    mockMatchMedia(900);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '打开频道动态' }));
    fireEvent.click(screen.getByTestId('rail-req-REQ-0042'));
    expect(screen.queryByRole('dialog', { name: '频道动态' })).not.toBeInTheDocument();
    const drawer = screen.getByTestId('wu-drawer');
    expect(drawer.dataset.kind).toBe('req');
    expect(drawer.dataset.id).toBe('REQ-0042');
  });

  it('窄屏（<768）：左栏从工作区卸载（并入全局 Sidebar）；中栏单栏 + 频道动态入口仍在', () => {
    mockMatchMedia(700);
    renderPage();
    expect(screen.queryByTestId('channel-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-rail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开频道动态' })).toBeInTheDocument();
  });
});
