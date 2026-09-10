// 批次 D-2 项5（docs/plans/2026-09-ui-interaction-polish.md）：PMO 需求索引 tab ——
// 全量 REQ 平铺（编号 + 标题 + 状态 + 关联 WU 计数 + 频道/项目归属）；
// 有频道归属行点击跳频道页（频道页右栏 = REQ 主呈现位），无归属禁跳并说明；空态 .empty-state
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockPost, mockChannelList, mockListAllAgents, mockProjectList, mockNavigate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockChannelList: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockProjectList: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

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

const mockProjects = [
  { id: 'p1', pmoNumber: 'PM-001', title: 'Project One', status: 'active', progress: 50, createdAt: '2026-01-01' },
];

const mockChannels = [
  { id: 'ch-1', name: '#rnd', type: 'rnd', members: '["agent-1"]' },
];

const mockReqs = [
  { id: 'REQ-0001', seq: 1, title: '登录功能', status: 'in-progress', channelId: 'ch-1', projectId: 'p1', createdAt: '2026-01-01', createdBy: 'manual' },
  { id: 'REQ-0002', seq: 2, title: '离线脚本', status: 'open', channelId: null, projectId: null, createdAt: '2026-01-02', createdBy: 'manual' },
];

const mockChainStats = {
  'REQ-0001': { finished: 1, total: 3 },
};

describe('PMOPage — 需求索引 tab（批次 D-2 项5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelList.mockResolvedValue({ data: { data: mockChannels } });
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockProjectList.mockResolvedValue({ data: { data: mockProjects } });
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      if (url.includes('/requirements/chain-stats')) return Promise.resolve({ data: { data: mockChainStats } });
      if (url.includes('/requirements')) return Promise.resolve({ data: { data: mockReqs } });
      return Promise.resolve({ data: { data: [] } });
    });
  });

  const renderPMO = () =>
    render(
      <MemoryRouter>
        <PMOPage companyId="co-1" />
      </MemoryRouter>
    );

  it('渲染第三个 tab「需求 (n)」（border-b 形态同项目/OKR tab）', async () => {
    renderPMO();

    const tab = (await screen.findByText(/需求 \(/)).closest('button')!;
    expect(tab.textContent).toContain('2');
    expect(tab.parentElement!.className).toContain('border-b');
  });

  it('切到需求 tab → 行 = 编号 + 标题 + 状态词 + 频道名 + 项目号 + 关联 WU 计数', async () => {
    renderPMO();

    fireEvent.click((await screen.findByText(/需求 \(/)).closest('button')!);

    await waitFor(() => expect(screen.getByText('登录功能')).toBeTruthy());
    expect(screen.getByText('REQ-0001')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();   // REQ 状态词表（RequirementChainPanel 同源）
    expect(screen.getByText('#rnd')).toBeTruthy();     // 频道名 formatChannelName 归一
    expect(screen.getByText('PM-001')).toBeTruthy();   // projectId → 项目号
    await waitFor(() => expect(screen.getByText('1/3')).toBeTruthy()); // chain-stats 批量计数

    // 第二条：open → 未开始
    expect(screen.getByText('离线脚本')).toBeTruthy();
    expect(screen.getByText('未开始')).toBeTruthy();
  });

  it('有频道归属行点击 → 跳频道页；无归属行禁跳并说明', async () => {
    renderPMO();

    fireEvent.click((await screen.findByText(/需求 \(/)).closest('button')!);
    await waitFor(() => expect(screen.getByText('登录功能')).toBeTruthy());

    fireEvent.click(screen.getByText('登录功能'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-1');

    // 无频道归属：说明文案 + 不可跳转
    expect(screen.getByText('无频道归属（不可跳转）')).toBeTruthy();
    mockNavigate.mockClear();
    fireEvent.click(screen.getByText('离线脚本'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('需求为空 → .empty-state 空态', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      return Promise.resolve({ data: { data: [] } });
    });
    renderPMO();

    fireEvent.click((await screen.findByText(/需求 \(/)).closest('button')!);

    const tip = await screen.findByText('暂无需求');
    expect(tip.closest('.empty-state')).not.toBeNull();
  });
});
