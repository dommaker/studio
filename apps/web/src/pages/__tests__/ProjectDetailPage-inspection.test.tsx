// #163 T8-E2: ProjectDetailPage「🔍 发起巡检」按钮 — fireTrigger('inspection-scan') + toast + 不跳转
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const {
  mockNavigate,
  mockApiGet,
  mockApiPost,
  mockGetProject,
  mockGetDelivery,
  mockGetChain,
  mockGetAgentSummary,
  mockFireTrigger,
  mockSuccess,
  mockError,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockGetProject: vi.fn(),
  mockGetDelivery: vi.fn(),
  mockGetChain: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockFireTrigger: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

// 只覆写 useNavigate（断言不跳转），其余（MemoryRouter/Link/Routes…）用真实现
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
  projectApi: { get: mockGetProject, getDelivery: mockGetDelivery },
}));
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    list: vi.fn().mockResolvedValue({ data: { data: [], total: 0 } }),
    get: vi.fn().mockRejectedValue(new Error('not found')),
  },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));
vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));
vi.mock('../../api/maintenance', () => ({
  maintenanceApi: { fireTrigger: mockFireTrigger },
}));
vi.mock('../../utils/toast', () => ({
  toast: { success: mockSuccess, error: mockError },
}));

import { ProjectDetailPage } from '../ProjectDetailPage';

const mockProject = {
  id: 'p1',
  pmoNumber: 'PMO-11',
  title: '巡检按钮项目',
  description: '项目描述',
  status: 'active',
  priority: 'high',
  progress: 40,
  reqAlias: 'REQ-0011',
  channelId: 'ch-1',
  deliveryPolicy: 'branch-only',
  createdAt: '2026-07-01',
};

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/pmo/project/p1']}>
      <Routes>
        <Route path="/pmo/project/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ProjectDetailPage — 🔍 发起巡检', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockResolvedValue({ data: mockProject });
    mockApiGet.mockResolvedValue({ data: [] });
    mockApiPost.mockResolvedValue({ data: {} });
    mockGetDelivery.mockRejectedValue(new Error('no delivery'));
    mockGetChain.mockResolvedValue({
      data: { data: { requirement: { id: 'REQ-0011', title: '巡检' }, workunits: [] } },
    });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    mockFireTrigger.mockResolvedValue({ fired: true, wasDisabled: false });
  });

  it('点击 → 调 fireTrigger(inspection-scan) + 成功 toast + 不跳转', async () => {
    renderDetail();
    const btn = await screen.findByRole('button', { name: '🔍 发起巡检' });

    fireEvent.click(btn);
    expect(mockFireTrigger).toHaveBeenCalledWith('inspection-scan');
    await waitFor(() => expect(mockSuccess).toHaveBeenCalledWith('巡检单已创建，待人确认'));
    // 不跳转：navigate 全程未被调用
    expect(mockNavigate).not.toHaveBeenCalled();
    // 页面仍在项目详情
    expect(screen.getByText('巡检按钮项目')).toBeInTheDocument();
  });

  it('触发失败 → 错误 toast，不跳转', async () => {
    mockFireTrigger.mockRejectedValue({ response: { data: { error: { message: '触发器不存在' } } } });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: '🔍 发起巡检' }));
    await waitFor(() => expect(mockError).toHaveBeenCalledWith('触发器不存在'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
