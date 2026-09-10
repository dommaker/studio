// ChannelRoutingEditor — #466：频道级「阶段→角色」路由表 UI
// 覆盖：三档下拉渲染（候选=频道成员）、存量路由回显、保存走 channelApi.update（乐观 + 失败回滚）
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { mockChannelGet, mockChannelUpdate } = vi.hoisted(() => ({
  mockChannelGet: vi.fn(),
  mockChannelUpdate: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    get: mockChannelGet,
    update: mockChannelUpdate,
  },
}));

import { ChannelRoutingEditor } from '../ChannelRoutingEditor';
import { useChannelDataStore } from '../../../stores/channelDataStore';
import { useRosterStore } from '../../../stores/rosterStore';

const mockAgentList = [
  { id: 'a1', name: 'analyst-pro', description: '规划', status: 'active' },
  { id: 'a2', name: 'worker-flash', description: '执行', status: 'active' },
  { id: 'a3', name: 'reviewer-third', description: null, status: 'active' },
  { id: 'a4', name: 'outsider', description: null, status: 'active' },
];

function seedStores(memberIds?: string[]) {
  useChannelDataStore.getState().__resetForTests();
  useRosterStore.setState({ profiles: mockAgentList, loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  if (memberIds) useChannelDataStore.getState().setMembers('ch-1', memberIds);
}

describe('ChannelRoutingEditor (#466)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelGet.mockResolvedValue({ data: { success: true, data: { id: 'ch-1', members: '[]', routing: undefined } } });
    mockChannelUpdate.mockResolvedValue({ data: { success: true, data: {} } });
    seedStores(['a1', 'a2', 'a3']);
  });

  it('renders trigger button（未配置显示「自动」）', () => {
    render(<ChannelRoutingEditor channelId="ch-1" />);
    expect(screen.getByTitle('工单路由（阶段→角色）')).toBeTruthy();
    expect(screen.getByText('自动')).toBeTruthy();
  });

  it('展开面板：三档下拉就位，候选 = 频道成员（非成员不献）', async () => {
    render(<ChannelRoutingEditor channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('工单路由（阶段→角色）'));

    await waitFor(() => expect(screen.getByLabelText('工单路由-plan')).toBeTruthy());
    expect(screen.getByLabelText('工单路由-implement')).toBeTruthy();
    expect(screen.getByLabelText('工单路由-review')).toBeTruthy();

    // 打开 plan 下拉：成员 a1/a2/a3 在候选，非成员 a4 不在
    fireEvent.click(screen.getByLabelText('工单路由-plan'));
    await waitFor(() => expect(screen.getByRole('option', { name: /@analyst-pro/ })).toBeTruthy());
    expect(screen.getByRole('option', { name: /@worker-flash/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /@reviewer-third/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /@outsider/ })).toBeNull();
    expect(screen.getByRole('option', { name: /自动认领/ })).toBeTruthy();
  });

  it('选择角色 → channelApi.update 落 routing（指名 plan 档）', async () => {
    render(<ChannelRoutingEditor channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('工单路由（阶段→角色）'));
    await waitFor(() => expect(screen.getByLabelText('工单路由-plan')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('工单路由-plan'));
    fireEvent.click(await screen.findByRole('option', { name: /@analyst-pro/ }));

    await waitFor(() =>
      expect(mockChannelUpdate).toHaveBeenCalledWith('ch-1', { routing: { plan: 'a1' } }));
  });

  it('存量路由回显 + 徽标计数（2/3）', async () => {
    mockChannelGet.mockResolvedValue({
      data: { success: true, data: { id: 'ch-1', members: '[]', routing: { plan: 'a1', review: 'a3' } } },
    });
    render(<ChannelRoutingEditor channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('工单路由（阶段→角色）'));

    await waitFor(() => {
      const planTrigger = screen.getByLabelText('工单路由-plan');
      expect(planTrigger.textContent).toContain('@analyst-pro');
    });
    const reviewTrigger = screen.getByLabelText('工单路由-review');
    expect(reviewTrigger.textContent).toContain('@reviewer-third');
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  it('清除某档（选回自动认领）→ routing 该档落 null', async () => {
    mockChannelGet.mockResolvedValue({
      data: { success: true, data: { id: 'ch-1', members: '[]', routing: { implement: 'a2' } } },
    });
    render(<ChannelRoutingEditor channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('工单路由（阶段→角色）'));
    await waitFor(() => expect(screen.getByLabelText('工单路由-implement')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('工单路由-implement'));
    fireEvent.click(await screen.findByRole('option', { name: /自动认领/ }));

    await waitFor(() =>
      expect(mockChannelUpdate).toHaveBeenCalledWith('ch-1', { routing: { implement: null } }));
  });

  it('保存失败 → 选中值回滚', async () => {
    mockChannelUpdate.mockRejectedValue(new Error('boom'));
    render(<ChannelRoutingEditor channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('工单路由（阶段→角色）'));
    await waitFor(() => expect(screen.getByLabelText('工单路由-review')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('工单路由-review'));
    fireEvent.click(await screen.findByRole('option', { name: /@reviewer-third/ }));

    await waitFor(() => expect(mockChannelUpdate).toHaveBeenCalled());
    // 回滚：review 触发器回到占位（自动认领）
    await waitFor(() => {
      const reviewTrigger = screen.getByLabelText('工单路由-review');
      expect(reviewTrigger.textContent).not.toContain('@reviewer-third');
    });
  });
});
