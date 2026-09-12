// AC-6: PMOPage 卡片徽章测试 — WU 完成度 x/y（批量并行、失败静默）
// #149（2026-08-15）：文档计数徽章随 document-store 退役移除
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockPost, mockChannelList, mockListAllAgents, mockChainStats, mockProjectList } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockChannelList: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockChainStats: vi.fn(),
  mockProjectList: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockGet, post: mockPost },
  projectApi: { publish: vi.fn(), list: mockProjectList },
}));
vi.mock('../../api/channel', () => ({
  channelApi: { list: mockChannelList, listAllAgents: mockListAllAgents },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { chainStats: mockChainStats },
}));

import { PMOPage } from '../PMOPage';
import { usePmoDataStore } from '../../stores/pmoDataStore';

const mockProjects = [
  { id: 'p1', pmoNumber: 'PM-001', title: 'Alpha', status: 'active', progress: 50, createdAt: '2026-01-01', reqAlias: 'REQ-0001' },
  { id: 'p2', pmoNumber: 'PM-002', title: 'Beta', status: 'pending', progress: 0, createdAt: '2026-01-02', reqAlias: null },
];

const renderPMO = () =>
  render(
    <MemoryRouter>
      <PMOPage companyId="co-1" />
    </MemoryRouter>,
  );

describe('AC-6: PMO 卡片徽章', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #456：company/project 链改读 pmoDataStore（模块级单例），每测重置避免 TTL 缓存跨测串味
    usePmoDataStore.getState().__resetForTests();
    mockChannelList.mockResolvedValue({ data: { data: [] } });
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockProjectList.mockResolvedValue({ data: { data: mockProjects } });
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      return Promise.resolve({ data: { data: [] } });
    });
    // #387：徽章统计走批量端点一次拉全（done/closed 算完成的 workFinished 口径在服务端）
    mockChainStats.mockResolvedValue({
      data: { data: { 'REQ-0001': { finished: 2, total: 3 } } },
    });
  });

  it('有 reqAlias 的项目显示任务 x/y 徽章；无别名不显示', async () => {
    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('任务 2/3')).toBeTruthy();
    });
    // 单请求批量：全部别名一次拉取
    expect(mockChainStats).toHaveBeenCalledTimes(1);
    expect(mockChainStats).toHaveBeenCalledWith(['REQ-0001']);
    // 徽章只出现一份（p2 无徽章）
    expect(screen.getAllByText(/任务 \d+\/\d+/)).toHaveLength(1);
  });

  it('批量统计失败：静默不显示徽章，卡片照常渲染', async () => {
    mockChainStats.mockRejectedValue(new Error('boom'));
    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeTruthy();
    });
    // 等一拍让徽章 effect 落定
    await waitFor(() => {
      expect(mockChainStats).toHaveBeenCalled();
    });
    expect(screen.queryByText(/WU \d+\/\d+/)).toBeNull();
  });
});
