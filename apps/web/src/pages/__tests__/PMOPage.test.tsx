// AC-6: PMO UI publish button tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockPost, mockChannelList, mockListAllAgents, mockProjectList } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockChannelList: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockProjectList: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    get: mockGet,
    post: mockPost,
  },
  projectApi: {
    publish: vi.fn(),
    list: mockProjectList,
  },
}));

vi.mock('../../api/channel', () => ({
  channelApi: {
    list: mockChannelList,
    listAllAgents: mockListAllAgents,
  },
}));

import { PMOPage } from '../PMOPage';
import { useRosterStore } from '../../stores/rosterStore';
import { usePmoDataStore } from '../../stores/pmoDataStore';

const mockProjects = [
  { id: 'p1', pmoNumber: 'PM-001', title: 'Pending Project', status: 'pending', progress: 0, createdAt: '2026-01-01' },
  { id: 'p2', pmoNumber: 'PM-002', title: 'Active Project', status: 'active', progress: 50, createdAt: '2026-01-02' },
];

const mockChannels = [
  { id: 'ch-1', name: '#general', type: 'rnd', members: '["agent-1"]' },
];

describe('AC-6: PMO publish button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #456：company/project 链改读 pmoDataStore（模块级单例），每测重置避免 TTL 缓存跨测串味
    usePmoDataStore.getState().__resetForTests();
    // #455：频道列表改读 rosterStore 切片（模块级单例），每测重置避免 TTL 缓存跨测串味
    useRosterStore.setState({
      profiles: [], agents: [], channels: [],
      loading: false, error: null, forbidden: false,
      loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
      inflight: null, lastToken: null,
    });
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockChannelList.mockResolvedValue({ data: { data: mockChannels } });
    mockListAllAgents.mockResolvedValue({ data: { data: [
      { id: 'agent-1', name: 'dev', status: 'active', description: null, channels: '[]' },
      { id: 'agent-2', name: 'pm', status: 'active', description: null, channels: '["ch-9"]' },
    ] } });

    // Mock the loadData Promise.all — companies/okr 走 mockGet，project 走 projectApi.list
    mockProjectList.mockResolvedValue({ data: { data: mockProjects } });
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      return Promise.resolve({ data: { data: [] } });
    });
  });

  const renderPMO = () =>
    render(
      <MemoryRouter>
        <PMOPage companyId="co-1" />
      </MemoryRouter>
    );

  it('shows publish button for pending project', async () => {
    renderPMO();

    await waitFor(() => {
      const buttons = screen.getAllByText('发起讨论');
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  it('does not show publish button for non-pending project', async () => {
    mockProjectList.mockResolvedValue({
      data: { data: [mockProjects[1]] }, // only active project
    });

    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('Active Project')).toBeTruthy();
    });

    expect(screen.queryAllByText('发起讨论')).toHaveLength(0);
  });

  it('disables button when no channels available', async () => {
    mockChannelList.mockResolvedValue({ data: { data: [] } });

    renderPMO();

    await waitFor(() => {
      const btn = screen.getAllByText('发起讨论')[0].closest('button');
      expect(btn).toBeTruthy();
      expect(btn!.disabled).toBe(true);
    });
  });

  it('dialog shows responder agents resolved from channel members', async () => {
    renderPMO();

    await waitFor(() => expect(screen.getAllByText('发起讨论').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('发起讨论')[0]);

    // #273：弹窗不预选频道，需显式选择后才解析响应成员
    fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
    fireEvent.click(screen.getByRole('option', { name: '#general' }));

    // members=["agent-1"] → 只显示 dev（pm 不在 members 里）
    await waitFor(() => expect(screen.getByText(/会响应的 Agent（1）：dev/)).toBeTruthy());
  });

  it('dialog falls back to profile.channels when members empty; warns when nobody responds', async () => {
    // 历史频道 members 未回填 → 回退 profile.channels 口径（dev channels=[] 全频道可见）
    mockChannelList.mockResolvedValue({ data: { data: [{ id: 'ch-1', name: '#general', type: 'rnd', members: '[]' }] } });

    renderPMO();
    await waitFor(() => expect(screen.getAllByText('发起讨论').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('发起讨论')[0]);
    fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
    fireEvent.click(screen.getByRole('option', { name: '#general' }));
    await waitFor(() => expect(screen.getByText(/会响应的 Agent（1）：dev/)).toBeTruthy());
  });

  it('dialog warns when channel has no responder', async () => {
    mockChannelList.mockResolvedValue({ data: { data: [{ id: 'ch-1', name: '#general', type: 'rnd', members: '["agent-x"]' }] } });

    renderPMO();
    await waitFor(() => expect(screen.getAllByText('发起讨论').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('发起讨论')[0]);
    fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
    fireEvent.click(screen.getByRole('option', { name: '#general' }));

    await waitFor(() => expect(screen.getByText(/无人认领/)).toBeTruthy());
  });

  it('E3：tab 归 border-b 形态（批次 D-4 定 Knowledge 为正本）+ 去 emoji', async () => {
    renderPMO();

    await waitFor(() => expect(screen.getByText(/项目 \(/)).toBeTruthy());
    const projectsTab = screen.getByText(/项目 \(/).closest('button')!;
    const okrTab = screen.getByText(/OKR \(/).closest('button')!;
    // 容器 = border-b 横条（非旧 segmented pill 容器）
    expect(projectsTab.parentElement!.className).toContain('border-b');
    expect(projectsTab.parentElement!.className).not.toContain('inline-flex');
    // 批次 E-3：激活态底线收进 .u-tab/.u-tab-active 结构类（禁内联 borderBottom）
    expect(projectsTab.className).toContain('u-tab');
    expect(projectsTab.className).toContain('u-tab-active');
    expect(okrTab.className).toContain('u-tab');
    expect(okrTab.className).not.toContain('u-tab-active');
  });
});
