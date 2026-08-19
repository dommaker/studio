// #286（决策 #251 Q2'）：设置区「默认执行机器」section 三修——
// 回显（已绑定值正确呈现）、非 Admin 403 降级（不无限加载）、孤儿绑定清理（失效提示 + 解绑）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockListWorkspaces, mockListChannels, mockUpdateChannel } = vi.hoisted(() => ({
  mockListWorkspaces: vi.fn(),
  mockListChannels: vi.fn(),
  mockUpdateChannel: vi.fn(),
}));

vi.mock('../../../api', () => ({
  workspaceApi: { list: mockListWorkspaces },
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    list: mockListChannels,
    update: mockUpdateChannel,
  },
}));

import { DefaultExecutionMachineSection } from '../DefaultExecutionMachineSection';

const CH_BOUND = { id: 'ch-1', name: '研发', type: 'rnd', defaultWorkspaceId: 'ws-vps' };
const CH_FREE = { id: 'ch-2', name: '决策', type: 'decision', defaultWorkspaceId: null };
const WS_LIST = [
  { id: 'ws-vps', name: 'VPS', status: 'idle' },
  { id: 'ws-local', name: '本机', status: 'idle' },
];

const forbidden = () => {
  const err = new Error('Request failed with status code 403') as Error & { response?: { status: number } };
  err.response = { status: 403 };
  return err;
};

describe('#286: DefaultExecutionMachineSection 默认执行机器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChannels.mockResolvedValue({ data: { success: true, data: [CH_BOUND, CH_FREE] } });
    mockListWorkspaces.mockResolvedValue({ data: { success: true, data: WS_LIST } });
    mockUpdateChannel.mockResolvedValue({ data: { success: true, data: {} } });
  });

  it('正名呈现「默认执行机器」并说明语义（WU 在哪台机器跑）', async () => {
    render(<DefaultExecutionMachineSection />);

    expect(screen.getByText(/默认执行机器/)).toBeTruthy();
    expect(screen.getByText(/WU 在哪台机器跑/)).toBeTruthy();
  });

  it('已绑定值正确回显：channel.defaultWorkspaceId 对应的机器名出现在该频道的选择器上', async () => {
    render(<DefaultExecutionMachineSection />);

    await waitFor(() => expect(screen.getByTestId('exec-machine-select-ch-1')).toBeTruthy());
    // 回显 = 触发器显示已绑定机器名，而非「无」
    expect(screen.getByTestId('exec-machine-select-ch-1').textContent).toContain('VPS');
    expect(screen.getByTestId('exec-machine-select-ch-2').textContent).toContain('无');
  });

  it('改选执行机器 → PATCH 频道 defaultWorkspaceId', async () => {
    render(<DefaultExecutionMachineSection />);
    await waitFor(() => expect(screen.getByTestId('exec-machine-select-ch-2')).toBeTruthy());

    fireEvent.click(screen.getByTestId('exec-machine-select-ch-2'));
    fireEvent.click(screen.getByRole('option', { name: 'VPS' }));

    await waitFor(() =>
      expect(mockUpdateChannel).toHaveBeenCalledWith('ch-2', { defaultWorkspaceId: 'ws-vps' }),
    );
  });

  it('非 Admin：workspaces 列表 403 → 明确「无权限」降级呈现，不无限加载，绑定值只读回显', async () => {
    mockListWorkspaces.mockRejectedValue(forbidden());
    render(<DefaultExecutionMachineSection />);

    await waitFor(() => expect(screen.getByText(/无权限/)).toBeTruthy());
    // 加载已结束（不无限加载）
    expect(screen.queryByText('加载中…')).toBeNull();
    // 绑定值以只读形式回显（机器 id 可见）
    expect(screen.getByText(/ws-vps/)).toBeTruthy();
    // 不出现在线编辑选择器
    expect(screen.queryByTestId('exec-machine-select-ch-1')).toBeNull();
  });

  it('孤儿绑定：绑定值指向已删除的机器 → 失效提示 + 解除绑定', async () => {
    mockListChannels.mockResolvedValue({
      data: { success: true, data: [{ ...CH_BOUND, defaultWorkspaceId: 'ws-gone' }] },
    });
    render(<DefaultExecutionMachineSection />);

    await waitFor(() => expect(screen.getByText(/绑定已失效/)).toBeTruthy());

    fireEvent.click(screen.getByText('解除绑定'));

    await waitFor(() =>
      expect(mockUpdateChannel).toHaveBeenCalledWith('ch-1', { defaultWorkspaceId: '' }),
    );
  });

  it('孤儿绑定解除成功后：该行回到正常选择器（值为「无」）', async () => {
    mockListChannels.mockResolvedValue({
      data: { success: true, data: [{ ...CH_BOUND, defaultWorkspaceId: 'ws-gone' }] },
    });
    mockUpdateChannel.mockResolvedValue({
      data: { success: true, data: { ...CH_BOUND, defaultWorkspaceId: null } },
    });
    render(<DefaultExecutionMachineSection />);

    await waitFor(() => expect(screen.getByText('解除绑定')).toBeTruthy());
    fireEvent.click(screen.getByText('解除绑定'));

    await waitFor(() => expect(screen.getByTestId('exec-machine-select-ch-1')).toBeTruthy());
    expect(screen.getByTestId('exec-machine-select-ch-1').textContent).toContain('无');
    expect(screen.queryByText(/绑定已失效/)).toBeNull();
  });
});
