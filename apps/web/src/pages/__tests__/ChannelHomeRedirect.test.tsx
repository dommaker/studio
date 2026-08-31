// #393 `/` 与 `/channels` 重定向进频道工作区：最近访问记忆 → rnd → 首频道 → 零频道空态
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom';

const { mockUseChannelList } = vi.hoisted(() => ({ mockUseChannelList: vi.fn() }));

vi.mock('../../hooks/useChannelList', () => ({
  useChannelList: () => mockUseChannelList(),
}));

// 零频道空态复用 CreateChannelForm（其内部会拉工程发现候选）——本套件不关心，置 stub
vi.mock('../../components/channel/CreateChannelForm', () => ({
  CreateChannelForm: () => <div data-testid="create-channel-form" />,
}));

import { ChannelHomeRedirect } from '../ChannelHomeRedirect';

const CHANNELS = [
  { id: 'ch-dec', name: 'decision', type: 'decision' },
  { id: 'ch-rnd', name: 'rnd', type: 'rnd' },
];

function WorkspaceStub() {
  const { id } = useParams();
  return <div data-testid="workspace">{id}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<ChannelHomeRedirect />} />
        <Route path="/channels" element={<ChannelHomeRedirect />} />
        <Route path="/channels/:id" element={<WorkspaceStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChannelHomeRedirect — #393', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('loading 中显示加载态，不跳转', () => {
    mockUseChannelList.mockReturnValue({ channels: [], loading: true, createChannel: vi.fn() });
    renderAt('/');
    expect(screen.getByText(/加载中/)).toBeTruthy();
    expect(screen.queryByTestId('workspace')).toBeNull();
  });

  it('有最近访问记忆且频道仍在 → 直达该频道', async () => {
    window.localStorage.setItem('studio:lastChannelId', 'ch-dec');
    mockUseChannelList.mockReturnValue({ channels: CHANNELS, loading: false, createChannel: vi.fn() });
    renderAt('/');
    await waitFor(() => expect(screen.getByTestId('workspace').textContent).toBe('ch-dec'));
  });

  it('记忆已失效（频道不在列表）→ 落 rnd 默认频道', async () => {
    window.localStorage.setItem('studio:lastChannelId', 'ch-deleted');
    mockUseChannelList.mockReturnValue({ channels: CHANNELS, loading: false, createChannel: vi.fn() });
    renderAt('/');
    await waitFor(() => expect(screen.getByTestId('workspace').textContent).toBe('ch-rnd'));
  });

  it('无记忆 → 落 rnd 默认频道（/channels 同样行为）', async () => {
    mockUseChannelList.mockReturnValue({ channels: CHANNELS, loading: false, createChannel: vi.fn() });
    renderAt('/channels');
    await waitFor(() => expect(screen.getByTestId('workspace').textContent).toBe('ch-rnd'));
  });

  it('零频道 → 空态 + 创建表单兜底', () => {
    mockUseChannelList.mockReturnValue({ channels: [], loading: false, createChannel: vi.fn() });
    renderAt('/');
    expect(screen.getByTestId('create-channel-form')).toBeTruthy();
  });
});
