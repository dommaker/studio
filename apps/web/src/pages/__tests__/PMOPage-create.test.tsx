// PMO-a: 新建 PMO 表单测试（打开 → 填写 → 提交断言参数 → 列表刷新）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockPost, mockChannelList, mockCreate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockChannelList: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    get: mockGet,
    post: mockPost,
  },
  projectApi: {
    publish: vi.fn(),
    create: mockCreate,
  },
}));

vi.mock('../../api/channel', () => ({
  channelApi: {
    list: mockChannelList,
  },
}));

import { PMOPage } from '../PMOPage';

const mockProjects = [
  { id: 'p1', pmoNumber: 'PMO-11', title: '既有项目', status: 'active', progress: 50, createdAt: '2026-01-01' },
];

describe('PMO-a: 新建 PMO 表单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelList.mockResolvedValue({ data: { data: [] } });
    mockCreate.mockResolvedValue({ data: { id: 'p2', pmoNumber: 'PMO-12' } });

    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      if (url.includes('/pmo/project')) return Promise.resolve({ data: { data: mockProjects } });
      return Promise.resolve({ data: { data: [] } });
    });
  });

  const renderPMO = () =>
    render(
      <MemoryRouter>
        <PMOPage companyId="co-1" />
      </MemoryRouter>
    );

  it('打开表单 → 填写 → 提交调 projectApi.create 且参数正确 → 列表刷新', async () => {
    renderPMO();

    // 等待列表加载完成
    await waitFor(() => {
      expect(screen.getByText('既有项目')).toBeTruthy();
    });

    // 打开内联表单
    fireEvent.click(screen.getByText('+ 新建 PMO'));
    expect(screen.getByPlaceholderText('项目标题')).toBeTruthy();

    // 填写字段
    fireEvent.change(screen.getByPlaceholderText('项目标题'), { target: { value: '证据链看板' } });
    fireEvent.change(screen.getByPlaceholderText('需求背景、验收标准等'), { target: { value: '展示 L1/L2/L3 证据' } });
    fireEvent.change(screen.getByPlaceholderText('/path/to/repo'), { target: { value: '/root/projects/studio' } });
    fireEvent.change(screen.getByDisplayValue('分支交付（不碰合并/发布）'), { target: { value: 'auto-merge' } });

    // 提交后列表返回新项目（模拟刷新）
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      if (url.includes('/pmo/project')) return Promise.resolve({
        data: { data: [...mockProjects, { id: 'p2', pmoNumber: 'PMO-12', title: '证据链看板', status: 'pending', progress: 0, createdAt: '2026-01-02' }] },
      });
      return Promise.resolve({ data: { data: [] } });
    });

    fireEvent.click(screen.getByText('创建'));

    // 断言 create 被调且参数正确（companyId 由服务端解析，前端不传）
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        title: '证据链看板',
        requirement: '展示 L1/L2/L3 证据',
        gitRepo: '/root/projects/studio',
        deliveryPolicy: 'auto-merge',
      });
    });

    // 列表刷新：新项目出现，表单已关闭
    await waitFor(() => {
      expect(screen.getByText('PMO-12')).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText('项目标题')).toBeNull();
  });

  it('标题为空时不提交并提示', async () => {
    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('既有项目')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('+ 新建 PMO'));
    fireEvent.click(screen.getByText('创建'));

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('空态文案指向新建 PMO 按钮', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      return Promise.resolve({ data: { data: [] } });
    });

    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('暂无项目，点击上方「新建 PMO」创建')).toBeTruthy();
    });
  });
});
