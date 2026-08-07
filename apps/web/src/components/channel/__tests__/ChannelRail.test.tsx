// ChannelRail — Mission Control 左栏 smoke test：频道渲染/选中/未读/新建/Agent 状态
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockUseChannelList, mockGetAgentSummary, mockNavigate } = vi.hoisted(() => ({
  mockUseChannelList: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('../../../hooks/useChannelList', () => ({
  useChannelList: () => mockUseChannelList(),
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ChannelRail } from '../ChannelRail';

const CHANNELS = [
  { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '["a1","a2"]' },
  { id: 'ch-2', name: 'decision-架构决策', type: 'decision' },
];

const AGENT_SUMMARY = {
  agents: [
    { id: 'a1', roleId: 'r1', name: 'coder-1', status: 'active', currentWorkUnitId: 'WU-1', startedAt: '2026-07-30T01:00:00Z' },
    { id: 'a2', roleId: 'r2', name: 'reviewer', status: 'idle', currentWorkUnitId: null, startedAt: '2026-07-30T01:00:00Z' },
    { id: 'a3', roleId: 'r3', name: 'archived', status: 'terminated', currentWorkUnitId: null, startedAt: '2026-07-30T01:00:00Z' },
    { id: 'a4', roleId: 'r1', name: 'coder-1-old', status: 'idle', currentWorkUnitId: null, startedAt: '2026-07-29T01:00:00Z' },
  ],
  summary: { total: 4, idle: 2, active: 1, error: 0, terminated: 1 },
};

const renderRail = (activeChannelId = 'ch-1') =>
  render(
    <MemoryRouter>
      <ChannelRail activeChannelId={activeChannelId} />
    </MemoryRouter>,
  );

describe('ChannelRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChannelList.mockReturnValue({
      channels: CHANNELS,
      loading: false,
      unreadCounts: { 'ch-2': 3 },
      clearUnread: vi.fn(),
      createChannel: vi.fn().mockResolvedValue({ id: 'ch-9', name: 'new', type: 'rnd' }),
    });
    mockGetAgentSummary.mockResolvedValue({ data: AGENT_SUMMARY });
  });

  it('renders channel list with active highlight and unread badge', () => {
    renderRail();
    const active = screen.getByText('rnd-主研发').closest('button')!;
    expect(active.className).toContain('mc-chan-active');
    expect(screen.getByText('3')).toBeTruthy(); // ch-2 未读 badge
  });

  it('shows per-channel agent online counts derived from members + agent summary', async () => {
    renderRail();
    // ch-1 members = [a1, a2]，两个都非 terminated → 2/2
    await waitFor(() => expect(screen.getByText('2/2')).toBeTruthy());
    // ch-2 无 members → 回退显示类型标签
    expect(screen.getByText('决策')).toBeTruthy();
  });

  it('navigates and clears unread on channel select', () => {
    const clearUnread = vi.fn();
    mockUseChannelList.mockReturnValue({
      channels: CHANNELS, loading: false, unreadCounts: { 'ch-2': 3 },
      clearUnread, createChannel: vi.fn(),
    });
    renderRail();
    fireEvent.click(screen.getByText('decision-架构决策'));
    expect(clearUnread).toHaveBeenCalledWith('ch-2');
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-2');
  });

  it('does not navigate when clicking the already-active channel', () => {
    renderRail('ch-1');
    fireEvent.click(screen.getByText('rnd-主研发'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('creates a new channel via the inline form and navigates to it', async () => {
    const createChannel = vi.fn().mockResolvedValue({ id: 'ch-9', name: 'ops', type: 'system' });
    mockUseChannelList.mockReturnValue({
      channels: CHANNELS, loading: false, unreadCounts: {},
      clearUnread: vi.fn(), createChannel,
    });
    renderRail();
    fireEvent.click(screen.getByText('+ 新频道'));
    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByLabelText('初始 Agent'), { target: { value: 'Watcher, Alerter' } });
    fireEvent.click(screen.getByText('创建'));
    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith({ name: 'ops', type: 'rnd', agents: ['Watcher', 'Alerter'] });
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-9'));
  });

  // 工单 38: 提交中 Button loading 态防连点重复提交
  it('disables the create button while submission is in flight', async () => {
    let resolveCreate: (v: any) => void;
    const createChannel = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveCreate = resolve; })
    );
    mockUseChannelList.mockReturnValue({
      channels: CHANNELS, loading: false, unreadCounts: {},
      clearUnread: vi.fn(), createChannel,
    });
    renderRail();
    fireEvent.click(screen.getByText('+ 新频道'));
    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: 'ops' } });

    fireEvent.click(screen.getByText('创建'));
    fireEvent.click(screen.getByText('创建中...'));

    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('创建中...').closest('button')!.disabled).toBe(true);

    resolveCreate!({ id: 'ch-9', name: 'ops', type: 'rnd' });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-9'));
  });

  it('renders agent status rows with pulse dot for active agents', async () => {
    renderRail();
    await waitFor(() => expect(screen.getByText('@coder-1')).toBeTruthy());
    const row = screen.getByText('@coder-1').closest('.mc-agent')!;
    expect(row.querySelector('.mc-dot-busy')).toBeTruthy();
    expect(screen.getByText('@reviewer')).toBeTruthy();
    // terminated 不显示
    expect(screen.queryByText('@archived')).toBeNull();
    // 同 roleId 去重：旧实例 coder-1-old 不显示
    expect(screen.queryByText('@coder-1-old')).toBeNull();
    // 汇总：online/visible = 2/2（active+idle / 非 terminated 去重后）
    expect(screen.getByText(/Agents · 2\/2/)).toBeTruthy();
  });
});
