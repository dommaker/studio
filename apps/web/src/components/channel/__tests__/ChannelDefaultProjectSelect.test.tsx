/**
 * #272（决策 #251 Q2'）：顶栏「默认工程」= 本地 repo 下拉。
 * 数据源 = /projects/discover（本地工程发现，非 Admin-only workspaces 接口），
 * 选中值落 channel.defaultPath；已绑定值不在候选集时仍回显。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChannelDefaultProjectSelect } from '../ChannelDefaultProjectSelect';

vi.mock('../../../api/channel', () => ({
  channelApi: {
    discoverProjects: vi.fn(),
    update: vi.fn(),
  },
}));

import { channelApi } from '../../../api/channel';

const mockProjects = [
  { name: 'studio', path: '/root/projects/studio', hasClaudeMd: true },
  { name: 'dommaker', path: '/root/projects/dommaker', hasClaudeMd: false },
];

describe('ChannelDefaultProjectSelect（#272 顶栏默认工程）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.discoverProjects).mockResolvedValue({
      data: { success: true, data: mockProjects },
    } as never);
    vi.mocked(channelApi.update).mockResolvedValue({} as never);
  });

  it('选项来自本地工程发现接口（非 workspaces），非 Admin 可用', async () => {
    render(<ChannelDefaultProjectSelect channelId="ch-1" defaultPath={null} />);
    fireEvent.click(screen.getByTitle('默认工程'));
    expect(await screen.findByRole('option', { name: 'studio' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'dommaker' })).toBeInTheDocument();
    expect(channelApi.discoverProjects).toHaveBeenCalled();
  });

  it('回显当前 defaultPath（选中项为工程名）', async () => {
    render(<ChannelDefaultProjectSelect channelId="ch-1" defaultPath="/root/projects/dommaker" />);
    await waitFor(() => {
      expect(screen.getByTitle('默认工程').textContent).toContain('dommaker');
    });
  });

  it('选中后落 channel.defaultPath', async () => {
    render(<ChannelDefaultProjectSelect channelId="ch-1" defaultPath={null} />);
    fireEvent.click(screen.getByTitle('默认工程'));
    fireEvent.click(await screen.findByRole('option', { name: 'studio' }));

    await waitFor(() => {
      expect(channelApi.update).toHaveBeenCalledWith('ch-1', {
        defaultPath: '/root/projects/studio',
      });
    });
  });

  it('选「无」清除默认工程（defaultPath 置空）', async () => {
    render(<ChannelDefaultProjectSelect channelId="ch-1" defaultPath="/root/projects/studio" />);
    fireEvent.click(screen.getByTitle('默认工程'));
    fireEvent.click(await screen.findByRole('option', { name: /无/ }));

    await waitFor(() => {
      expect(channelApi.update).toHaveBeenCalledWith('ch-1', { defaultPath: '' });
    });
  });

  it('已绑定值不在发现候选集时仍回显（不丢绑定）', async () => {
    vi.mocked(channelApi.discoverProjects).mockResolvedValue({
      data: { success: true, data: [] },
    } as never);
    render(<ChannelDefaultProjectSelect channelId="ch-1" defaultPath="/opt/legacy-repo" />);
    await waitFor(() => {
      expect(screen.getByTitle('默认工程').textContent).toContain('/opt/legacy-repo');
    });
  });
});
