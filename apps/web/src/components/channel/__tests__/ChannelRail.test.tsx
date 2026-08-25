// ChannelRail — Mission Control 左栏 smoke test：频道渲染/选中/未读/新建/Agent 状态
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockUseChannelList, mockGetAgentSummary, mockNavigate, mockOnEvent, mockCtx } = vi.hoisted(() => ({
  mockUseChannelList: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockNavigate: vi.fn(),
  mockOnEvent: vi.fn(),
  mockCtx: { status: 'disconnected' as string },
}));

vi.mock('../../../hooks/useChannelList', () => ({
  useChannelList: () => mockUseChannelList(),
}));

vi.mock('../../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, status: mockCtx.status }),
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

// #272：创建表单（CreateChannelForm）加载本地工程发现候选——单测置空即可
vi.mock('../../../api/channel', () => ({
  channelApi: { discoverProjects: vi.fn().mockResolvedValue({ data: { success: true, data: [] } }) },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ChannelRail } from '../ChannelRail';
import type { ChannelListItem } from '../../../hooks/useChannelList';

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
    mockCtx.status = 'disconnected';
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
    let resolveCreate: (v: ChannelListItem) => void;
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

  // #283：非 Admin 访问 Admin-only monitoring 接口的降级体验
  it('403 → 渲染「无权限」终态而非恒加载，并停止 30s 轮询', async () => {
    vi.useFakeTimers();
    try {
      const err = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
      mockGetAgentSummary.mockRejectedValue(err);
      renderRail();
      await act(async () => {}); // flush 挂载首查的 rejection
      expect(screen.getByText(/无权限查看 Agent 状态/)).toBeTruthy();
      expect(screen.queryByText('加载中…')).toBeNull();
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
      // 403 后轮询停止：推进 2 个周期不再发请求
      await act(async () => { vi.advanceTimersByTime(60000); });
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('非 403 错误 → 维持现状（吞错，下轮继续重试）', async () => {
    vi.useFakeTimers();
    try {
      mockGetAgentSummary.mockRejectedValue(new Error('Network Error'));
      renderRail();
      await act(async () => {});
      expect(screen.queryByText(/无权限/)).toBeNull();
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(30000); });
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // #313：轮询经 useGatedPoll——SSE 连接正常时不起表，推进计时器零周期请求
  it('#313：SSE connected 时仅首拉一次，fake timers 推进不发周期请求', async () => {
    mockCtx.status = 'connected';
    vi.useFakeTimers();
    try {
      renderRail();
      await act(async () => {}); // flush 挂载首拉
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(120000); });
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // #312：SSE agent.instance.status_changed 就地更新状态点/lastError，不等 30s 轮询
  it('#312：SSE 状态事件就地更新 agent 行（状态文案 + lastError tooltip + 计数重算）', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    renderRail();
    await waitFor(() => expect(screen.getByText('@reviewer')).toBeTruthy());
    expect(screen.getByText(/Agents · 2\/2/)).toBeTruthy();

    act(() => {
      handler!({
        event_type: 'agent.instance.status_changed',
        data: {
          profileId: 'r2', instanceId: 'a2', name: 'reviewer', status: 'error',
          currentWorkUnitId: null, currentWorkUnit: null, channelId: null,
          lastError: 'health probe timeout', lastErrorAt: '2026-08-24T02:00:00Z',
        },
      });
    });

    const row = screen.getByText('@reviewer').closest('.mc-agent')!;
    expect(row.textContent).toContain('error');
    expect(row.getAttribute('title')).toBe('health probe timeout');
    // error 不算 online → 计数 1/2（前端从 agents 状态重算，不等轮询）
    expect(screen.getByText(/Agents · 1\/2/)).toBeTruthy();
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
  });

  // #313：SSE 事件不匹配任何已加载实例 = 新角色实例 → 负载合成条目加入列表（轮询不再承担发现职责）
  it('#313：SSE 新实例事件合成进列表（名字渲染 + 计数重算），非目标事件不动名册', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    renderRail();
    await waitFor(() => expect(screen.getByText('@coder-1')).toBeTruthy());

    act(() => {
      handler!({
        event_type: 'agent.instance.status_changed',
        data: { profileId: 'r-unknown', instanceId: 'a-unknown', name: 'ghost', status: 'active', currentWorkUnitId: null, currentWorkUnit: null, channelId: null, lastError: null, lastErrorAt: null },
      });
      handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'WU-1', status: 'done' } } });
    });

    expect(screen.getByText('@ghost')).toBeTruthy();
    // active 算 online → 计数 3/3（原 2/2 + ghost）
    expect(screen.getByText(/Agents · 3\/3/)).toBeTruthy();
  });
});
