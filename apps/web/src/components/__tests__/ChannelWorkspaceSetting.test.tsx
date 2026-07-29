/**
 * ChannelWorkspaceSetting tests — P8-03 Channel defaultWorkspace setting
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChannelWorkspaceSetting } from '../ChannelWorkspaceSetting';

vi.mock('../../api', () => ({
  workspaceApi: {
    list: vi.fn(),
  },
}));

vi.mock('../../api/channel', () => ({
  channelApi: {
    update: vi.fn(),
  },
}));

import { workspaceApi } from '../../api';
import { channelApi } from '../../api/channel';

const mockWorkspaces = [
  { id: 'ws-1', name: '公司电脑', status: 'online', runtimes: [], _count: { runtimes: 0 } },
  { id: 'ws-2', name: '个人 PC', status: 'offline', runtimes: [], _count: { runtimes: 0 } },
];

describe('ChannelWorkspaceSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workspaceApi.list as any).mockResolvedValue({ data: { data: mockWorkspaces } });
  });

  it('renders workspace options', async () => {
    render(<ChannelWorkspaceSetting channelId="ch-1" />);
    // 自定义 Select：选项在打开的面板中（portal 到 body）
    fireEvent.click(screen.getByTitle('默认工程'));
    expect(await screen.findByRole('option', { name: '公司电脑' })).toBeInTheDocument();
  });

  it('shows current workspace as selected', async () => {
    render(<ChannelWorkspaceSetting channelId="ch-1" defaultWorkspaceId="ws-2" />);
    // 触发器显示当前选中项文案
    await waitFor(() => {
      expect(screen.getByTitle('默认工程').textContent).toContain('个人 PC');
    });
  });

  it('updates channel workspace on change', async () => {
    (channelApi.update as any).mockResolvedValue({});
    render(<ChannelWorkspaceSetting channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('默认工程'));
    fireEvent.click(await screen.findByRole('option', { name: '公司电脑' }));

    await waitFor(() => {
      expect(channelApi.update).toHaveBeenCalledWith('ch-1', expect.objectContaining({
        defaultWorkspaceId: 'ws-1',
      }));
    });
  });
});
