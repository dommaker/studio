// 工单 38: PMOPage loadData 失败反馈 — 页面内错误条 + 重试（原先仅 console.error 静默）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockChannelList, mockProjectList } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockChannelList: vi.fn(),
  mockProjectList: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockGet, post: vi.fn() },
  projectApi: { publish: vi.fn(), list: mockProjectList },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { list: mockChannelList, listAllAgents: vi.fn() },
}));

import { PMOPage } from '../PMOPage';

describe('工单 38: PMOPage loadData 失败反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelList.mockResolvedValue({ data: { data: [] } });
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      return Promise.resolve({ data: { data: [] } });
    });
  });

  const renderPMO = () =>
    render(
      <MemoryRouter>
        <PMOPage companyId="co-1" />
      </MemoryRouter>
    );

  it('loadData 失败时显示错误条与重试按钮', async () => {
    mockProjectList.mockRejectedValue(new Error('boom'));
    renderPMO();

    expect(await screen.findByText('加载 PMO 数据失败，请重试')).toBeTruthy();
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('点击重试后恢复列表并清除错误条', async () => {
    mockProjectList
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({
        data: { data: [{ id: 'p1', pmoNumber: 'PM-001', title: 'Recovered', status: 'active', progress: 10, createdAt: '2026-01-01' }] },
      });
    renderPMO();

    fireEvent.click(await screen.findByText('重试'));

    await waitFor(() => expect(screen.getByText('Recovered')).toBeTruthy());
    expect(screen.queryByText('加载 PMO 数据失败，请重试')).toBeNull();
  });
});
