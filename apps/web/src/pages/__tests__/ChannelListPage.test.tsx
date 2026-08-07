// 工单 38: ChannelListPage 创建频道 — Button loading 态防连点重复提交
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockUseChannelList, mockGetAgentSummary } = vi.hoisted(() => ({
  mockUseChannelList: vi.fn(),
  mockGetAgentSummary: vi.fn(),
}));

vi.mock('../../hooks/useChannelList', () => ({
  useChannelList: () => mockUseChannelList(),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

import { ChannelListPage } from '../ChannelListPage';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels']}>
      <ChannelListPage />
    </MemoryRouter>
  );

describe('工单 38: ChannelListPage 创建频道 loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentSummary.mockResolvedValue({ data: { agents: [] } });
  });

  it('提交中按钮禁用并显示 loading 文案，createChannel 只调用一次', async () => {
    let resolveCreate: (v: any) => void;
    const createChannel = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveCreate = resolve; })
    );
    mockUseChannelList.mockReturnValue({
      channels: [], loading: false, unreadCounts: {},
      clearUnread: vi.fn(), createChannel,
    });
    renderPage();

    fireEvent.click(screen.getByText('+ 新频道'));
    fireEvent.change(screen.getByPlaceholderText('#频道名称'), { target: { value: 'ops' } });

    const btn = screen.getByText('创建').closest('button')!;
    fireEvent.click(btn);
    fireEvent.click(btn);

    // 连点只触发一次提交，按钮进入 loading 禁用态
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('创建中...')).toBeTruthy();
    expect(screen.getByText('创建中...').closest('button')!.disabled).toBe(true);

    resolveCreate!({ id: 'ch-9', name: 'ops', type: 'rnd' });
    await waitFor(() => expect(screen.queryByText('创建中...')).toBeNull());
  });

  it('创建失败时通过错误弹窗反馈（非原生 alert）', async () => {
    const createChannel = vi.fn().mockRejectedValue(new Error('boom'));
    mockUseChannelList.mockReturnValue({
      channels: [], loading: false, unreadCounts: {},
      clearUnread: vi.fn(), createChannel,
    });
    renderPage();

    fireEvent.click(screen.getByText('+ 新频道'));
    fireEvent.change(screen.getByPlaceholderText('#频道名称'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('创建'));

    expect(await screen.findByText('创建频道失败')).toBeTruthy();
    // 弹窗关闭后按钮恢复可点
    fireEvent.click(screen.getByText('知道了'));
    await waitFor(() => expect(screen.getByText('创建').closest('button')!.disabled).toBe(false));
  });
});
