// AC-6: PMOPage 卡片徽章测试 — WU 完成度 x/y + 文档计数（批量并行、失败静默）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockPost, mockChannelList, mockListAllAgents, mockGetChain, mockListByProject } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockChannelList: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockGetChain: vi.fn(),
  mockListByProject: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockGet, post: mockPost },
  projectApi: { publish: vi.fn() },
}));
vi.mock('../../api/channel', () => ({
  channelApi: { list: mockChannelList, listAllAgents: mockListAllAgents },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));
vi.mock('../../api/knowledge', () => ({
  knowledgeApi: { listByProject: mockListByProject },
}));

import { PMOPage } from '../PMOPage';

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
    mockChannelList.mockResolvedValue({ data: { data: [] } });
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      if (url.includes('/pmo/project')) return Promise.resolve({ data: { data: mockProjects } });
      return Promise.resolve({ data: { data: [] } });
    });
    // p1：3 个 WU，done + closed 算完成（workFinished 口径），active 不算
    mockGetChain.mockResolvedValue({
      data: {
        data: {
          requirement: { id: 'REQ-0001', title: 'Alpha' },
          workunits: [
            { id: 'wu-1', title: '甲', status: 'done', assigneeId: null, metadata: null },
            { id: 'wu-2', title: '乙', status: 'active', assigneeId: null, metadata: null },
            { id: 'wu-3', title: '丙', status: 'closed', assigneeId: null, metadata: null },
          ],
        },
      },
    });
    mockListByProject.mockImplementation((projectId: string) => {
      if (projectId === 'p1') return Promise.resolve({ data: { documents: [{ id: 'd1' }, { id: 'd2' }] } });
      return Promise.reject(new Error('knowledge unavailable'));
    });
  });

  it('有 reqAlias 的项目显示 WU x/y 与文档计数徽章；无别名/查询失败不显示', async () => {
    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('WU 2/3')).toBeTruthy();
    });
    expect(screen.getByText('📄 2')).toBeTruthy();
    // chain 只对有别名的 p1 调一次
    expect(mockGetChain).toHaveBeenCalledTimes(1);
    expect(mockGetChain).toHaveBeenCalledWith('REQ-0001');
    // 徽章只出现一份（p2 无徽章）
    expect(screen.getAllByText(/WU \d+\/\d+/)).toHaveLength(1);
    expect(screen.getAllByText(/📄 \d+/)).toHaveLength(1);
  });

  it('chain / knowledge 全部失败：静默不显示徽章，卡片照常渲染', async () => {
    mockGetChain.mockRejectedValue(new Error('boom'));
    mockListByProject.mockRejectedValue(new Error('boom'));
    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeTruthy();
    });
    // 等一拍让徽章 effect 落定
    await waitFor(() => {
      expect(mockListByProject).toHaveBeenCalled();
    });
    expect(screen.queryByText(/WU \d+\/\d+/)).toBeNull();
    expect(screen.queryByText(/📄 \d+/)).toBeNull();
  });
});
