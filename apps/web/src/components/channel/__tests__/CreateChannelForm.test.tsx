/**
 * #272（决策 #251 Q3/Q7）：创建频道表单单一实现（ChannelListPage / ChannelRail 共用）。
 * 可选「默认工程」（本地 repo，可留空）；选中随创建落 channel.defaultPath；
 * 提交中防连点；失败内联报错；不含「默认执行机器」（Admin 概念，不进创建表单）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateChannelForm } from '../CreateChannelForm';
import type { ChannelListItem } from '../../../hooks/useChannelList';

vi.mock('../../../api/channel', () => ({
  channelApi: {
    discoverProjects: vi.fn(),
  },
}));

import { channelApi } from '../../../api/channel';

const mockProjects = [
  { name: 'studio', path: '/root/projects/studio', hasClaudeMd: true },
  { name: 'dommaker', path: '/root/projects/dommaker', hasClaudeMd: false },
];

function renderForm(overrides: Partial<Parameters<typeof CreateChannelForm>[0]> = {}) {
  const props = {
    createChannel: vi.fn().mockResolvedValue({ id: 'ch-9', name: '#ops', type: 'rnd' }),
    onCreated: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<CreateChannelForm {...props} />);
  return props;
}

describe('CreateChannelForm（#272 创建频道表单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.discoverProjects).mockResolvedValue({
      data: { success: true, data: mockProjects },
    } as never);
  });

  it('渲染名称/初始 Agent/类型/可选默认工程（本地工程发现数据源）', async () => {
    renderForm();
    expect(screen.getByLabelText('频道名称')).toBeInTheDocument();
    expect(screen.getByLabelText('初始 Agent')).toBeInTheDocument();
    expect(screen.getByLabelText('频道类型')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('默认工程'));
    expect(await screen.findByRole('option', { name: 'studio' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'dommaker' })).toBeInTheDocument();
    // 「默认执行机器」不进创建表单
    expect(screen.queryByLabelText('默认执行机器')).toBeNull();
  });

  it('默认工程可留空：createChannel 不带 defaultPath', async () => {
    const { createChannel, onCreated } = renderForm();
    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith({ name: 'ops', type: 'rnd', agents: [] });
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch-9' }),
    ));
  });

  it('选中默认工程 → 随创建落 defaultPath', async () => {
    const { createChannel } = renderForm();
    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByLabelText('默认工程'));
    fireEvent.click(await screen.findByRole('option', { name: 'studio' }));
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith({
        name: 'ops', type: 'rnd', agents: [], defaultPath: '/root/projects/studio',
      });
    });
  });

  it('初始 Agent 逗号拆分；类型可选 decision', async () => {
    const { createChannel } = renderForm();
    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: '决策室' } });
    fireEvent.change(screen.getByLabelText('初始 Agent'), { target: { value: 'Analyst, Reviewer' } });
    fireEvent.click(screen.getByLabelText('频道类型'));
    fireEvent.click(await screen.findByRole('option', { name: '决策' }));
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith({
        name: '决策室', type: 'decision', agents: ['Analyst', 'Reviewer'],
      });
    });
  });

  it('名称为空不提交；提交中防连点', async () => {
    let resolveCreate: (v: ChannelListItem) => void;
    const createChannel = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveCreate = resolve; }),
    );
    renderForm({ createChannel });

    fireEvent.click(screen.getByText('创建'));
    expect(createChannel).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('创建'));
    fireEvent.click(screen.getByText('创建中...'));
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('创建中...').closest('button')!.disabled).toBe(true);

    resolveCreate!({ id: 'ch-9', name: '#ops', type: 'rnd' });
    await waitFor(() => expect(screen.queryByText('创建中...')).toBeNull());
  });

  it('创建失败内联报错；取消回调', async () => {
    const createChannel = vi.fn().mockRejectedValue({ response: { data: { error: '重名' } } });
    const { onCancel } = renderForm({ createChannel });

    fireEvent.change(screen.getByLabelText('频道名称'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('创建'));
    expect(await screen.findByText('重名')).toBeInTheDocument();

    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalled();
  });
});
