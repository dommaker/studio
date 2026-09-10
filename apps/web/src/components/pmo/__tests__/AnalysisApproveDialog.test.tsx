// AnalysisApproveDialog — #463 结构化评审表单（原 #106 M7 魔法行 textarea 版退役）：
// 左 FOG 待决清单（增删改）+ 右 TASK 拆分预览（行内编辑/勾选剔除）+
// 三按钮（确认开图/不开图直接派工/打回补充）+ #177 默认执行角色下拉 + 批次A 项7 提交反馈
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import { AnalysisApproveDialog, ANALYSIS_REJECT_REASON } from '../AnalysisApproveDialog';
import type { AnalysisConfirmPrefill } from '../mapUtils';

const PREFILL: AnalysisConfirmPrefill = {
  destination: '三仓特性联动上线',
  fog: ['存储选型用哪个？', '部署形态先单机还是分布式？'],
  tasks: ['实现存储层', '接通派工'],
};

function setup(overrides: Record<string, unknown> = {}) {
  const props = {
    prefill: PREFILL,
    onConfirm: vi.fn(),
    onReject: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<AnalysisApproveDialog {...props} />);
  return props;
}

describe('AnalysisApproveDialog — #463 结构化评审表单', () => {
  it('预填：目标/待决进左栏输入框，TASK 进右栏预览（默认全勾选）', () => {
    setup();
    expect((screen.getByLabelText('目标') as HTMLInputElement).value).toBe('三仓特性联动上线');
    expect((screen.getByLabelText('待决问题 1') as HTMLInputElement).value).toBe('存储选型用哪个？');
    expect((screen.getByLabelText('待决问题 2') as HTMLInputElement).value).toBe('部署形态先单机还是分布式？');
    expect((screen.getByLabelText('派工任务 1') as HTMLInputElement).value).toBe('实现存储层');
    expect((screen.getByLabelText('纳入派工 2') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('派工预览（2 条将派工）')).toBeTruthy();
  });

  it('确认开图 → confirm 带 destination/fog/tasks 全量（人审改后生效：删一条雾、改一条任务）', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByLabelText('删除待决问题 2'));
    fireEvent.change(screen.getByLabelText('派工任务 1'), { target: { value: '  存储层（改） ' } });

    fireEvent.click(screen.getByText('确认开图'));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'analysis',
      destination: '三仓特性联动上线',
      fog: ['存储选型用哪个？'],
      tasks: ['存储层（改）', '接通派工'],
    }, undefined);
  });

  it('勾选剔除 TASK → 预览计数与 confirm tasks 同步收缩', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByLabelText('纳入派工 2'));
    expect(screen.getByText('派工预览（1 条将派工）')).toBeTruthy();

    fireEvent.click(screen.getByText('确认开图'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ tasks: ['实现存储层'] }), undefined);
  });

  it('不开图直接派工 → confirm 不带 destination/fog，仅 tasks（fog 再满也不开图）', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText('不开图直接派工'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'analysis', tasks: ['实现存储层', '接通派工'] }, undefined);
  });

  it('清空待决后确认开图 = 非探路型：fog 空数组回传（后端据此不开图）', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByLabelText('删除待决问题 1'));
    fireEvent.click(screen.getByLabelText('删除待决问题 1')); // 删后重编号，剩余项仍是 1
    fireEvent.click(screen.getByText('确认开图'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ fog: [] }), undefined);
  });

  it('添加待决 → 新增空行可填并随 confirm 回传', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText('添加待决'));
    fireEvent.change(screen.getByLabelText('待决问题 3'), { target: { value: '新提出的问题？' } });
    fireEvent.click(screen.getByText('确认开图'));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ fog: ['存储选型用哪个？', '部署形态先单机还是分布式？', '新提出的问题？'] }),
      undefined,
    );
  });

  it('打回补充 → onReject 带预设理由，不触发 onConfirm', () => {
    const { onReject, onConfirm } = setup();
    fireEvent.click(screen.getByText('打回补充'));
    expect(onReject).toHaveBeenCalledWith(ANALYSIS_REJECT_REASON);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('空预填（agent 无产出）→ 右栏提示不自动派工，确认开图回传空 fog/空 tasks', () => {
    const { onConfirm } = setup({ prefill: { destination: '', fog: [], tasks: [] } });
    expect(screen.getByText(/agent 未输出 TASK 拆分/)).toBeTruthy();
    fireEvent.click(screen.getByText('确认开图'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'analysis', fog: [], tasks: [] }, undefined);
  });

  it('取消按钮 / 关闭 × / 遮罩点击 → onCancel，不触发 onConfirm', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByText('取消'));
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
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

  it('带 channelId：候选=频道成员（非成员不在列）；选中后确认 → onConfirm 第二参回传 profile id', async () => {
    const { onConfirm } = setup({ channelId: 'ch-1' });

    const trigger = await screen.findByRole('button', { name: '默认执行角色' });
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'dev' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ops' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'outsider' })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: 'dev' }));
    fireEvent.click(screen.getByText('确认开图'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'analysis' }), 'p1');
  });

  it('无 channelId → 不渲染角色下拉（存量调用形态不变）', () => {
    setup();
    expect(screen.queryByRole('button', { name: '默认执行角色' })).toBeNull();
    expect(mockChannelGet).not.toHaveBeenCalled();
  });
});

// 批次A 项7：onConfirm 返回 Promise —— 提交期间 loading + 禁用 + 遮罩不关闭；失败内联错误保持打开
describe('批次A 项7：弹窗提交反馈', () => {
  it('onConfirm 未结算期间：确认键 loading/禁用，取消与遮罩关闭被屏蔽', async () => {
    let resolve: () => void = () => {};
    const onConfirm = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    const onCancel = vi.fn();
    const { container } = render(
      <AnalysisApproveDialog prefill={PREFILL} onConfirm={onConfirm} onReject={vi.fn()} onCancel={onCancel} />,
    );

    const confirmBtn = screen.getByText('确认开图').closest('button')!;
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(confirmBtn.disabled).toBe(true));
    expect(confirmBtn.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('取消').closest('button')!.disabled).toBe(true);

    fireEvent.click(screen.getByText('取消'));
    fireEvent.click(container.querySelector('.modal-overlay')!);
    expect(onCancel).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(confirmBtn.disabled).toBe(false));
  });

  it('onConfirm reject → 弹窗不关 + 内联错误行；重试成功由调用方关窗', async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error('审查硬门已关闭'))
      .mockResolvedValueOnce(undefined);
    const onCancel = vi.fn();
    render(<AnalysisApproveDialog prefill={PREFILL} onConfirm={onConfirm} onReject={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('确认开图'));
    expect(await screen.findByText('审查硬门已关闭')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled(); // 未关窗
    expect(screen.getByText('确认分析结论')).toBeTruthy(); // 弹窗仍在

    fireEvent.click(screen.getByText('确认开图'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('审查硬门已关闭')).toBeNull()); // 重试清错误行
  });
});
