// WuGateActions — E2-4 三处合一闸门动作组件契约：分支 / pending 锁存 / 失败内联 / 弹窗成功才关 / autoApprove 一次性
// （三消费方接线各自由 WorkUnitListPage / WorkUnitDrawer / WorkUnitDetailPage 测试覆盖，本文件锚共享行为）
// #545：写路径内建 gateWriter——本文件 mock 写模块，只断组件到模块的调用形状（渲染级）；
// API 透传 + store 双写契约由 utils/__tests__/gateWriter.test.ts 单点覆盖。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockToast, mockReviewPassed, mockReviewRejected, mockConfirmPending, mockCreateGateWriter } = vi.hoisted(() => {
  const mockReviewPassed = vi.fn();
  const mockReviewRejected = vi.fn();
  const mockConfirmPending = vi.fn();
  return {
    mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
    mockReviewPassed,
    mockReviewRejected,
    mockConfirmPending,
    mockCreateGateWriter: vi.fn(() => ({
      reviewPassed: mockReviewPassed,
      reviewRejected: mockReviewRejected,
      confirmPending: mockConfirmPending,
    })),
  };
});
vi.mock('../../../utils/toast', () => ({ toast: mockToast }));
vi.mock('../../../utils/gateWriter', () => ({ createGateWriter: mockCreateGateWriter }));

import { WuGateActions } from '../WuGateActions';
import type { WorkUnit } from '../../api/workunit';

function makeWu(overrides: Record<string, unknown>): WorkUnit {
  return {
    id: 'wu-1',
    scope: '测试任务',
    type: 'task',
    status: 'in_review',
    metadata: null,
    channelId: null,
    assigneeId: null,
    reqId: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    completedAt: null,
    claimedAt: null,
    retryCount: 0,
    failureType: null,
    ...overrides,
  } as unknown as WorkUnit;
}

const L2_ONLY = JSON.stringify({
  attestations: {
    l1: { verdict: 'approved', by: 'dev', at: 't', kind: 'verify' },
    l2: { verdict: 'approved', by: 'rev', at: 't', kind: 'agent-review' },
    // l3 缺失 → needsHuman
  },
});

function setup(wu: WorkUnit, extra: { autoApprove?: boolean; onUpdated?: (w: WorkUnit) => void } = {}) {
  return render(
    <WuGateActions wu={wu} autoApprove={extra.autoApprove} onUpdated={extra.onUpdated} />,
  );
}

describe('WuGateActions — 状态分支（E2-4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReviewPassed.mockResolvedValue({});
    mockReviewRejected.mockResolvedValue({});
    mockConfirmPending.mockResolvedValue({});
  });

  it('pending → 「确认并开放领取」调 gateWriter.confirmPending(id)', () => {
    setup(makeWu({ status: 'pending' }));
    fireEvent.click(screen.getByText('确认并开放领取'));
    expect(mockConfirmPending).toHaveBeenCalledWith('wu-1');
  });

  it('in_review → 「通过验收」+「拒绝」；task 直调 gateWriter.reviewPassed(id)', () => {
    setup(makeWu({ status: 'in_review' }));
    fireEvent.click(screen.getByText('通过验收'));
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1');
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('done 缺 l3 → 「人工验收确认」调 gateWriter.reviewPassed（同端点幂等补写）', () => {
    setup(makeWu({ status: 'done', metadata: L2_ONLY }));
    fireEvent.click(screen.getByText('人工验收确认'));
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1');
  });

  it('宿主 onUpdated 落点透传给 createGateWriter（#545 单一可选 sink）', () => {
    const onUpdated = vi.fn();
    setup(makeWu({ status: 'pending' }), { onUpdated });
    expect(mockCreateGateWriter).toHaveBeenCalledWith(onUpdated);
  });

  it('active / blocked / done 有 l3 → 不渲染任何闸门动作', () => {
    const l3 = JSON.stringify({
      attestations: {
        l1: { verdict: 'approved', by: 'dev', at: 't', kind: 'verify' },
        l2: { verdict: 'approved', by: 'rev', at: 't', kind: 'agent-review' },
        l3: { verdict: 'approved', by: 'human', at: 't', kind: 'human-confirm' },
      },
    });
    for (const wu of [makeWu({ status: 'active' }), makeWu({ status: 'blocked' }), makeWu({ status: 'done', metadata: l3 })]) {
      const { container, unmount } = render(<WuGateActions wu={wu} />);
      expect(container.querySelector('button')).toBeNull();
      unmount();
    }
  });
});

describe('WuGateActions — 反馈兜底（批次A 模式）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReviewPassed.mockResolvedValue({});
    mockReviewRejected.mockResolvedValue({});
    mockConfirmPending.mockResolvedValue({});
  });

  it('pending 锁存：未结算前连击只调一次，按钮禁用', async () => {
    let resolve: () => void = () => {};
    mockReviewPassed.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    setup(makeWu({ status: 'in_review' }));

    const btn = screen.getByText('通过验收').closest('button')!;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn);
    expect(mockReviewPassed).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it('失败 → gateError 内联（服务端 error.message 优先）；再次尝试前清除', async () => {
    mockReviewPassed
      .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: { message: '状态机不允许该迁移' } } },
      }))
      .mockResolvedValueOnce({});
    setup(makeWu({ status: 'in_review' }));

    fireEvent.click(screen.getByText('通过验收'));
    expect(await screen.findByText('状态机不允许该迁移')).toBeTruthy();

    fireEvent.click(screen.getByText('通过验收'));
    await waitFor(() => expect(screen.queryByText('状态机不允许该迁移')).toBeNull());
  });

  it('拒绝弹窗：原因 trim 后回传，空原因 → undefined；成功才关窗', async () => {
    setup(makeWu({ status: 'in_review' }));

    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.change(screen.getByPlaceholderText(/拒绝原因/), { target: { value: '  返工  ' } });
    fireEvent.click(screen.getByText('确认拒绝'));
    await waitFor(() => expect(mockReviewRejected).toHaveBeenCalledWith('wu-1', '返工'));
    await waitFor(() => expect(screen.queryByText('拒绝原因')).toBeNull()); // 成功关窗
  });

  it('点击闸门区不冒泡（列表行整行可点场景）', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <WuGateActions wu={makeWu({ status: 'in_review' })} />
      </div>,
    );
    fireEvent.click(screen.getByText('通过验收'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('WuGateActions — #463 结构化确认弹窗（analysis/decision/spec）与 autoApprove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReviewPassed.mockResolvedValue({});
    mockReviewRejected.mockResolvedValue({});
    mockConfirmPending.mockResolvedValue({});
  });

  it('analysis 点通过 → AnalysisApproveDialog 结构化预填，确认开图后 confirm 表单回传', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'analysis',
      metadata: JSON.stringify({ analysisDestination: '目的地', analysisFog: ['问题1'], analysisTasks: ['干活'] }),
    }));

    fireEvent.click(screen.getByText('通过验收'));
    expect((await screen.findByLabelText('目标') as HTMLInputElement).value).toBe('目的地');
    expect((screen.getByLabelText('待决问题 1') as HTMLInputElement).value).toBe('问题1');
    expect((screen.getByLabelText('派工任务 1') as HTMLInputElement).value).toBe('干活');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('确认开图'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined, {
      kind: 'analysis', destination: '目的地', fog: ['问题1'], tasks: ['干活'],
    }));
  });

  it('#471 plan 点通过 → 同一结构化弹窗（标题「确认规划结论」），confirm kind=plan 回传', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'plan',
      metadata: JSON.stringify({ analysisDestination: '目的地', analysisFog: ['问题1'], analysisTasks: ['干活'] }),
    }));

    fireEvent.click(screen.getByText('通过验收'));
    expect(await screen.findByText('确认规划结论')).toBeTruthy();
    expect((screen.getByLabelText('待决问题 1') as HTMLInputElement).value).toBe('问题1');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('确认开图'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined, {
      kind: 'plan', destination: '目的地', fog: ['问题1'], tasks: ['干活'],
    }));
  });

  it('decision 点通过 → DecisionApproveDialog 预填 agent 建议结论，采纳后 confirm 回传', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'decision',
      scope: '待决问题 PMO-1: 存储选型？',
      metadata: JSON.stringify({ decisionSuggestion: '用 SQLite' }),
    }));

    fireEvent.click(screen.getByText('通过验收'));
    expect((await screen.findByLabelText('决策结论') as HTMLTextAreaElement).value).toBe('用 SQLite');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('采纳结论'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined, {
      kind: 'decision', conclusion: '用 SQLite',
    }));
  });

  it('decision 弹窗「转人工讨论」→ reviewRejected 预设理由并关窗', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'decision',
      metadata: JSON.stringify({ decisionSuggestion: '用 SQLite' }),
    }));

    fireEvent.click(screen.getByText('通过验收'));
    fireEvent.click(await screen.findByText('转人工讨论'));
    await waitFor(() => expect(mockReviewRejected).toHaveBeenCalledWith('wu-1', expect.stringContaining('转人工讨论')));
    await waitFor(() => expect(screen.queryByText('确认决策结论')).toBeNull());
  });

  it('spec 点通过 → SpecApproveDialog 卡片墙预填，确认物化后 confirm 回传勾选集', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'spec',
      metadata: JSON.stringify({ specTasks: [{ title: '实现存储层', ac: ['单测覆盖'], blockedBy: [] }] }),
    }));

    fireEvent.click(screen.getByText('通过验收'));
    expect((await screen.findByLabelText('任务标题 1') as HTMLInputElement).value).toBe('实现存储层');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('确认物化（1）'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined, {
      kind: 'spec', tasks: [{ title: '实现存储层', ac: ['单测覆盖'] }],
    }));
  });

  it('spec 无 specTasks（旧数据/agent 未拆）→ 空卡片墙，可添加任务后物化（不再一键烧掉哨兵）', async () => {
    setup(makeWu({ status: 'in_review', type: 'spec', metadata: null }));

    fireEvent.click(screen.getByText('通过验收'));
    fireEvent.click(await screen.findByText('添加任务'));
    fireEvent.change(screen.getByLabelText('任务标题 1'), { target: { value: '补录的任务' } });
    fireEvent.click(screen.getByText('确认物化（1）'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined, {
      kind: 'spec', tasks: [{ title: '补录的任务', ac: [] }],
    }));
  });

  it('autoApprove：in_review analysis 挂载即弹（一次性，无需点通过）', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'analysis',
      metadata: JSON.stringify({ analysisDestination: '目的地', analysisFog: ['问题1'] }),
    }), { autoApprove: true });

    expect((await screen.findByLabelText('目标') as HTMLInputElement).value).toBe('目的地');
    expect((screen.getByLabelText('待决问题 1') as HTMLInputElement).value).toBe('问题1');
  });

  it('autoApprove 但非 analysis/非 in_review → 不自动弹窗', () => {
    setup(makeWu({ status: 'in_review', type: 'task' }), { autoApprove: true });
    expect(screen.queryByText('确认分析结论')).toBeNull();
  });
});

describe('WuGateActions — #468 闸门动作成功 toast 说明后续', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReviewPassed.mockResolvedValue({});
    mockReviewRejected.mockResolvedValue({});
    mockConfirmPending.mockResolvedValue({});
  });

  it('pending 确认成功 → toast 说明进待领取队列', async () => {
    setup(makeWu({ status: 'pending' }));
    fireEvent.click(screen.getByText('确认并开放领取'));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('待领取')));
  });

  it('task 直通过成功 → toast 说明已过审查闸门', async () => {
    setup(makeWu({ status: 'in_review' }));
    fireEvent.click(screen.getByText('通过验收'));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('审查闸门')));
  });

  it('analysis 弹窗确认成功 → toast 说明将自动派工', async () => {
    setup(makeWu({
      status: 'in_review', type: 'analysis',
      metadata: JSON.stringify({ analysisDestination: '目的地', analysisFog: [], analysisTasks: ['干活'] }),
    }));
    fireEvent.click(screen.getByText('通过验收'));
    fireEvent.click(await screen.findByText('确认开图'));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('自动派工')));
  });

  it('拒绝成功 → toast.info 说明打回返工', async () => {
    setup(makeWu({ status: 'in_review' }));
    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.click(screen.getByText('确认拒绝'));
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith(expect.stringContaining('返工')));
  });

  it('动作失败 → 不弹 toast（错误仍走 gateError 内联）', async () => {
    mockReviewPassed.mockRejectedValue(new Error('boom'));
    setup(makeWu({ status: 'in_review' }));
    fireEvent.click(screen.getByText('通过验收'));
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.info).not.toHaveBeenCalled();
  });
});
