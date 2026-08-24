// PublishProjectDialog — #177 可选「指定分析角色」下拉：默认留空=涌现，候选=频道成员，
// 不阻塞主交互；projectApi.publish 带可选 assigneeId
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockPublish, mockListAllAgents, mockListChannels } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
}));
vi.mock('../../../api', () => ({
  projectApi: { publish: (...args: unknown[]) => mockPublish(...args) },
}));
vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAllAgents: (...args: unknown[]) => mockListAllAgents(...args),
    list: (...args: unknown[]) => mockListChannels(...args),
  },
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
  // #290（清单 #25）：弹窗打开时自取频道列表；默认与 props 一致
  mockListChannels.mockResolvedValue({ data: { data: CHANNELS } });
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
  // 与真实使用一致：弹窗从关闭态打开（open 上升沿重置表单）
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

// #273：发布弹窗不预选频道——角色下拉等频道联动内容需先显式选择频道
async function selectChannel(name = '#dev') {
  fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
  fireEvent.click(screen.getByRole('option', { name }));
}

describe('#273 发布弹窗不预选频道（发布时点绑定是唯一入口，须用户显式选择）', () => {
  it('打开弹窗不默认选中任何频道（显示占位提示）', async () => {
    renderDialog();

    const trigger = await screen.findByRole('button', { name: '目标频道' });
    expect(trigger.textContent).toContain('请选择目标频道');
  });

  it('未选频道时确认发起禁用；显式选择后可发起', async () => {
    renderDialog();

    const confirm = await screen.findByText('确认发起');
    expect(confirm).toHaveProperty('disabled', true);

    await selectChannel();
    expect(screen.getByText('确认发起')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByText('确认发起'));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('proj-1', 'ch-1', undefined));
  });
});

describe('PublishProjectDialog #177 指定分析角色', () => {
  it('角色下拉默认留空（自动认领），候选=频道成员（非成员不在列）', async () => {
    renderDialog();
    await selectChannel();

    const trigger = await screen.findByRole('button', { name: '指定分析角色' });
    expect(trigger.textContent).toContain('自动认领');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'dev' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ops' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'outsider' })).toBeNull();
  });

  it('不选角色确认发起 → publish 不带 assigneeId（留空=涌现，不阻塞主交互）', async () => {
    renderDialog();
    await selectChannel();

    await screen.findByRole('button', { name: '指定分析角色' });
    fireEvent.click(screen.getByText('确认发起'));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('proj-1', 'ch-1', undefined));
  });

  it('选中成员后确认发起 → publish 带该 profile id 作为 assigneeId', async () => {
    renderDialog();
    await selectChannel();

    fireEvent.click(await screen.findByRole('button', { name: '指定分析角色' }));
    fireEvent.click(screen.getByRole('option', { name: 'dev' }));
    fireEvent.click(screen.getByText('确认发起'));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('proj-1', 'ch-1', 'p1'));
  });
});

// #290（清单 #25）：空成员语义对齐 + 频道下拉选项完整性
describe('PublishProjectDialog #290 空成员语义与频道选项', () => {
  const EMPTY_MEMBER_CHANNEL = [{ id: 'ch-9', name: '#ops', type: 'rnd', members: '[]' }];

  function renderDialogWith(channels: { id: string; name: string; type: string; members: string }[]) {
    const utils = render(
      <PublishProjectDialog open={false} projectId="proj-1" channels={channels} onClose={vi.fn()} onPublished={vi.fn()} />,
    );
    utils.rerender(
      <PublishProjectDialog open projectId="proj-1" channels={channels} onClose={vi.fn()} onPublished={vi.fn()} />,
    );
    return utils;
  }

  it('频道下拉列出打开时自取的全部频道（不止 props 挂载期的滞后子集）', async () => {
    // props 只有 #dev（模拟 PMOPage 挂载期滞后）；自取列表含新建频道 #ops
    mockListChannels.mockResolvedValue({ data: { data: [...CHANNELS, ...EMPTY_MEMBER_CHANNEL] } });
    renderDialogWith(CHANNELS);

    fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
    await waitFor(() => expect(screen.getByRole('option', { name: '#ops' })).toBeTruthy());
    expect(screen.getByRole('option', { name: '#dev' })).toBeTruthy();
  });

  it('真无响应者时警告出现，且文案写明「空成员 = 所有 Agent 可见」判定口径', async () => {
    mockListChannels.mockResolvedValue({ data: { data: EMPTY_MEMBER_CHANNEL } });
    mockListAllAgents.mockResolvedValue({ data: { data: [] } }); // 无任何 active Agent
    renderDialogWith(EMPTY_MEMBER_CHANNEL);

    fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
    fireEvent.click(screen.getByRole('option', { name: '#ops' }));
    const warn = await screen.findByText(/没有可响应的 Agent/);
    expect(warn.textContent).toContain('频道成员为空 = 所有未限定频道的 Agent 可见');
  });

  it('空成员频道但有可见 Agent 时：不警告，列出会响应的 Agent（与成员面板口径一致）', async () => {
    mockListChannels.mockResolvedValue({ data: { data: EMPTY_MEMBER_CHANNEL } });
    // active Agent 未限定频道（channels 为空）→ 空成员频道下全员可响应
    mockListAllAgents.mockResolvedValue({
      data: { data: [{ id: 'p1', name: 'dev', status: 'active', channels: '[]' }] },
    });
    renderDialogWith(EMPTY_MEMBER_CHANNEL);

    fireEvent.click(await screen.findByRole('button', { name: '目标频道' }));
    fireEvent.click(screen.getByRole('option', { name: '#ops' }));
    await screen.findByText(/会响应的 Agent（1）：dev/);
    expect(screen.queryByText(/没有可响应的 Agent/)).toBeNull();
  });
});
