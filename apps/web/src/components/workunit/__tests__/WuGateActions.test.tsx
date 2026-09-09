// WuGateActions — E2-4 三处合一闸门动作组件契约：分支 / pending 锁存 / 失败内联 / 弹窗成功才关 / autoApprove 一次性
// （三消费方接线各自由 WorkUnitListPage / WorkUnitDrawer / WorkUnitDetailPage 测试覆盖，本文件锚共享行为）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

function setup(wu: WorkUnit, extra: { autoApprove?: boolean } = {}) {
  const props = {
    onReviewPassed: vi.fn().mockResolvedValue({}),
    onReviewRejected: vi.fn().mockResolvedValue({}),
    onConfirmPending: vi.fn().mockResolvedValue({}),
  };
  const utils = render(
    <WuGateActions wu={wu} autoApprove={extra.autoApprove} {...props} />,
  );
  return { ...props, ...utils };
}

describe('WuGateActions — 状态分支（E2-4）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pending → 「确认（进待领取）」调 onConfirmPending', () => {
    const { onConfirmPending } = setup(makeWu({ status: 'pending' }));
    fireEvent.click(screen.getByText('确认（进待领取）'));
    expect(onConfirmPending).toHaveBeenCalledTimes(1);
  });

  it('in_review → 「通过（审查闸门）」+「拒绝」；task 直调 onReviewPassed', () => {
    const { onReviewPassed } = setup(makeWu({ status: 'in_review' }));
    fireEvent.click(screen.getByText('通过（审查闸门）'));
    expect(onReviewPassed).toHaveBeenCalledWith();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('done 缺 l3 → 「人工确认（留痕）」调 onReviewPassed（同端点幂等补写）', () => {
    const { onReviewPassed } = setup(makeWu({ status: 'done', metadata: L2_ONLY }));
    fireEvent.click(screen.getByText('人工确认（留痕）'));
    expect(onReviewPassed).toHaveBeenCalledWith();
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
      const { container, unmount } = render(
        <WuGateActions wu={wu} onReviewPassed={vi.fn()} onReviewRejected={vi.fn()} onConfirmPending={vi.fn()} />,
      );
      expect(container.querySelector('button')).toBeNull();
      unmount();
    }
  });
});

describe('WuGateActions — 反馈兜底（批次A 模式）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pending 锁存：未结算前连击只调一次，按钮禁用', async () => {
    let resolve: () => void = () => {};
    const onReviewPassed = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    render(
      <WuGateActions wu={makeWu({ status: 'in_review' })} onReviewPassed={onReviewPassed} onReviewRejected={vi.fn()} onConfirmPending={vi.fn()} />,
    );

    const btn = screen.getByText('通过（审查闸门）').closest('button')!;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn);
    expect(onReviewPassed).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it('失败 → gateError 内联（服务端 error.message 优先）；再次尝试前清除', async () => {
    const onReviewPassed = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: { message: '状态机不允许该迁移' } } },
      }))
      .mockResolvedValueOnce({});
    render(
      <WuGateActions wu={makeWu({ status: 'in_review' })} onReviewPassed={onReviewPassed} onReviewRejected={vi.fn()} onConfirmPending={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('通过（审查闸门）'));
    expect(await screen.findByText('状态机不允许该迁移')).toBeTruthy();

    fireEvent.click(screen.getByText('通过（审查闸门）'));
    await waitFor(() => expect(screen.queryByText('状态机不允许该迁移')).toBeNull());
  });

  it('拒绝弹窗：原因 trim 后回传，空原因 → undefined；成功才关窗', async () => {
    const onReviewRejected = vi.fn().mockResolvedValue({});
    render(
      <WuGateActions wu={makeWu({ status: 'in_review' })} onReviewPassed={vi.fn()} onReviewRejected={onReviewRejected} onConfirmPending={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.change(screen.getByPlaceholderText(/拒绝原因/), { target: { value: '  返工  ' } });
    fireEvent.click(screen.getByText('确认拒绝'));
    await waitFor(() => expect(onReviewRejected).toHaveBeenCalledWith('返工'));
    await waitFor(() => expect(screen.queryByText('拒绝原因')).toBeNull()); // 成功关窗
  });

  it('点击闸门区不冒泡（列表行整行可点场景）', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <WuGateActions wu={makeWu({ status: 'in_review' })} onReviewPassed={vi.fn()} onReviewRejected={vi.fn()} onConfirmPending={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByText('通过（审查闸门）'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('WuGateActions — analysis 弹窗与 autoApprove', () => {
  beforeEach(() => vi.clearAllMocks());

  it('analysis 点通过 → AnalysisApproveDialog 预填待决清单，确认后 summary 回传', async () => {
    const { onReviewPassed } = setup(makeWu({
      status: 'in_review',
      type: 'analysis',
      metadata: JSON.stringify({ analysisDestination: '目的地', analysisFog: ['问题1'] }),
    }));

    fireEvent.click(screen.getByText('通过（审查闸门）'));
    const textarea = await screen.findByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('目标：目的地\n待决：问题1');
    expect(onReviewPassed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('确认通过'));
    await waitFor(() => expect(onReviewPassed).toHaveBeenCalledWith('目标：目的地\n待决：问题1', undefined));
  });

  it('autoApprove：in_review analysis 挂载即弹（一次性，无需点通过）', async () => {
    setup(makeWu({
      status: 'in_review',
      type: 'analysis',
      metadata: JSON.stringify({ analysisDestination: '目的地', analysisFog: ['问题1'] }),
    }), { autoApprove: true });

    const textarea = await screen.findByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('目标：目的地\n待决：问题1');
  });

  it('autoApprove 但非 analysis/非 in_review → 不自动弹窗', () => {
    setup(makeWu({ status: 'in_review', type: 'task' }), { autoApprove: true });
    expect(screen.queryByPlaceholderText(/目标/)).toBeNull();
  });
});
