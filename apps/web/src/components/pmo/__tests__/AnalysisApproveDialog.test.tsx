// AnalysisApproveDialog — #106 M7 analysis 确认弹窗共享件（自 WorkUnitListPage 抽出）
// 预填展示 / 人改后 summary 回传 / 空清单直接通过 / 取消（按钮、关闭 ×、遮罩点击）
// #177：可选「默认执行角色」下拉（候选=频道成员，默认留空=涌现）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockChannelGet, mockListAllAgents } = vi.hoisted(() => ({
  mockChannelGet: vi.fn(),
  mockListAllAgents: vi.fn(),
}));
vi.mock('../../../api/channel', () => ({
  channelApi: {
    get: (...args: unknown[]) => mockChannelGet(...args),
    listAllAgents: (...args: unknown[]) => mockListAllAgents(...args),
  },
}));

import { AnalysisApproveDialog } from '../AnalysisApproveDialog';

const PREFILL = '目标：三仓特性联动上线\n待决：存储选型用哪个？\n待决：部署形态先单机还是分布式？';

describe('AnalysisApproveDialog', () => {
  it('预填文本进 textarea；人审改后确认 → onConfirm 回传改后文本', () => {
    const onConfirm = vi.fn();
    render(<AnalysisApproveDialog prefill={PREFILL} onConfirm={onConfirm} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe(PREFILL);

    // 人审改：删掉一条雾
    fireEvent.change(textarea, { target: { value: '待决：存储选型用哪个？' } });
    fireEvent.click(screen.getByText('确认通过'));

    expect(onConfirm).toHaveBeenCalledWith('待决：存储选型用哪个？', undefined);
  });

  it('空预填（无清单 metadata）→ 空文本，直接确认 → onConfirm 回传空串（非探路型不开图）', () => {
    const onConfirm = vi.fn();
    render(<AnalysisApproveDialog prefill="" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    fireEvent.click(screen.getByText('确认通过'));
    expect(onConfirm).toHaveBeenCalledWith('', undefined);
  });

  it('取消按钮 / 关闭 × / 遮罩点击 → onCancel，不触发 onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container, unmount } = render(
      <AnalysisApproveDialog prefill={PREFILL} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onCancel).toHaveBeenCalledTimes(2);

    fireEvent.click(container.querySelector('.modal-overlay')!);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
  });
});

describe('#177 默认执行角色下拉（候选=频道成员，留空=涌现）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelGet.mockResolvedValue({
      data: { data: { id: 'ch-1', name: '#dev', type: 'rnd', members: '["p1","p2"]' } },
    });
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

  it('带 channelId：候选=频道成员（非成员不在列），默认留空不阻塞主交互', async () => {
    render(<AnalysisApproveDialog prefill="" channelId="ch-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const trigger = await screen.findByRole('button', { name: '默认执行角色' });
    expect(trigger.textContent).toContain('自动认领');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'dev' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ops' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'outsider' })).toBeNull();
  });

  it('不选角色直接确认 → onConfirm 第二参为 undefined（留空=涌现）', async () => {
    const onConfirm = vi.fn();
    render(<AnalysisApproveDialog prefill="" channelId="ch-1" onConfirm={onConfirm} onCancel={vi.fn()} />);

    await screen.findByRole('button', { name: '默认执行角色' });
    fireEvent.click(screen.getByText('确认通过'));
    expect(onConfirm).toHaveBeenCalledWith('', undefined);
  });

  it('选中成员后确认 → onConfirm 回传该 profile id', async () => {
    const onConfirm = vi.fn();
    render(<AnalysisApproveDialog prefill="" channelId="ch-1" onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '默认执行角色' }));
    fireEvent.click(screen.getByRole('option', { name: 'dev' }));
    fireEvent.click(screen.getByText('确认通过'));
    expect(onConfirm).toHaveBeenCalledWith('', 'p1');
  });

  it('无 channelId → 不渲染角色下拉（存量调用形态不变）', () => {
    render(<AnalysisApproveDialog prefill="" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '默认执行角色' })).toBeNull();
    expect(mockChannelGet).not.toHaveBeenCalled();
  });
});
