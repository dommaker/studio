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
    expect(await screen.findByText('公司电脑')).toBeInTheDocument();
  });

  it('shows current workspace as selected', async () => {
    render(<ChannelWorkspaceSetting channelId="ch-1" defaultWorkspaceId="ws-2" />);
    await screen.findByText('公司电脑');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('ws-2');
  });

  it('updates channel workspace on change', async () => {
    (channelApi.update as any).mockResolvedValue({});
    render(<ChannelWorkspaceSetting channelId="ch-1" />);
    await screen.findByText('公司电脑');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ws-1' } });

    await waitFor(() => {
      expect(channelApi.update).toHaveBeenCalledWith('ch-1', expect.objectContaining({
        defaultWorkspaceId: 'ws-1',
      }));
    });
  });
});
