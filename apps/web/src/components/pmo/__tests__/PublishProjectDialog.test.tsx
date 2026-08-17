// PublishProjectDialog — #177 可选「指定分析角色」下拉：默认留空=涌现，候选=频道成员，
// 不阻塞主交互；projectApi.publish 带可选 assigneeId
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockPublish, mockListAllAgents } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockListAllAgents: vi.fn(),
}));
vi.mock('../../../api', () => ({
  projectApi: { publish: (...args: unknown[]) => mockPublish(...args) },
}));
vi.mock('../../../api/channel', () => ({
  channelApi: { listAllAgents: (...args: unknown[]) => mockListAllAgents(...args) },
}));
vi.mock('../../../utils/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { PublishProjectDialog } from '../PublishProjectDialog';

const CHANNELS = [
  { id: 'ch-1', name: '#dev', type: 'rnd', members: '["p1","p2"]' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue({});
  mockListAllAgents.mockResolvedValue({
    data: {
      data: [
        { id: 'p1', name: 'dev', status: 'active' },
        { id: 'p2', name: 'ops', status: 'active' },
        { id: 'p3', name: 'outsider', status: 'active' },
      ],
    },
  });
});

function renderDialog(onPublished = vi.fn()) {
  // 与真实使用一致：弹窗从关闭态打开（open 上升沿才默认选中第一个频道）
  const utils = render(
    <PublishProjectDialog
      open={false}
      projectId="proj-1"
      channels={CHANNELS}
      onClose={vi.fn()}
      onPublished={onPublished}
    />,
  );
  utils.rerender(
    <PublishProjectDialog
      open
      projectId="proj-1"
      channels={CHANNELS}
      onClose={vi.fn()}
      onPublished={onPublished}
    />,
  );
  return utils;
}

describe('PublishProjectDialog #177 指定分析角色', () => {
  it('角色下拉默认留空（自动认领），候选=频道成员（非成员不在列）', async () => {
    renderDialog();

    const trigger = await screen.findByRole('button', { name: '指定分析角色' });
    expect(trigger.textContent).toContain('自动认领');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'dev' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ops' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'outsider' })).toBeNull();
  });

  it('不选角色确认发起 → publish 不带 assigneeId（留空=涌现，不阻塞主交互）', async () => {
    renderDialog();

    await screen.findByRole('button', { name: '指定分析角色' });
    fireEvent.click(screen.getByText('确认发起'));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('proj-1', 'ch-1', undefined));
  });

  it('选中成员后确认发起 → publish 带该 profile id 作为 assigneeId', async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: '指定分析角色' }));
    fireEvent.click(screen.getByRole('option', { name: 'dev' }));
    fireEvent.click(screen.getByText('确认发起'));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('proj-1', 'ch-1', 'p1'));
  });
});
