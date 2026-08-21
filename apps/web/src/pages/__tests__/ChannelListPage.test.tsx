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

// #272：创建表单（CreateChannelForm）加载本地工程发现候选——单测置空即可
vi.mock('../../api/channel', () => ({
  channelApi: { discoverProjects: vi.fn().mockResolvedValue({ data: { success: true, data: [] } }) },
}));

import { ChannelListPage } from '../ChannelListPage';
import type { ChannelListItem } from '../../hooks/useChannelList';

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
    let resolveCreate: (v: ChannelListItem) => void;
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

  it('创建失败时内联报错（#272 表单合并后两处统一内联错误）', async () => {
    const createChannel = vi.fn().mockRejectedValue(new Error('boom'));
    mockUseChannelList.mockReturnValue({
      channels: [], loading: false, unreadCounts: {},
      clearUnread: vi.fn(), createChannel,
    });
    renderPage();

    fireEvent.click(screen.getByText('+ 新频道'));
    fireEvent.change(screen.getByPlaceholderText('#频道名称'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('创建'));

    expect(await screen.findByText('创建失败')).toBeTruthy();
    // 失败后按钮恢复可点
    await waitFor(() => expect(screen.getByText('创建').closest('button')!.disabled).toBe(false));
  });

  // #283：非 Admin 访问 Admin-only monitoring 接口的降级体验
  it('Agent 状态栏 403 → 渲染「无权限」终态而非恒加载', async () => {
    const err = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
    mockGetAgentSummary.mockRejectedValue(err);
    mockUseChannelList.mockReturnValue({
      channels: [], loading: false, unreadCounts: {},
      clearUnread: vi.fn(), createChannel: vi.fn(),
    });
    renderPage();
    expect(await screen.findByText(/无权限查看 Agent 状态/)).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
