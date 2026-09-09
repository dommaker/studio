/**
 * DeliveryPanel tests - PMO-b/F6-c 交付面板（Card 7 从 ProjectDetailPage 抽取）
 * 重点：handleGapAction 状态码 → toast 矩阵（verify 422/409、dispatchReview 409、兜底）
 * 附带：台账渲染 / deliver 成功刷新 / deliver 409 内联缺口与冲突清单
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const {
  mockNavigate,
  mockDeliver,
  mockMarkDelivered,
  mockVerify,
  mockDispatchReview,
  mockReviewPassed,
  mockWuGet,
  mockToastSuccess,
  mockToastError,
  mockToastInfo,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockDeliver: vi.fn(),
  mockMarkDelivered: vi.fn(),
  mockVerify: vi.fn(),
  mockDispatchReview: vi.fn(),
  mockReviewPassed: vi.fn(),
  mockWuGet: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../api', () => ({
  projectApi: { deliver: mockDeliver, markDelivered: mockMarkDelivered },
}));

vi.mock('../../../api/workunit', () => ({
  workunitApi: {
    get: mockWuGet,
    verify: mockVerify,
    dispatchReview: mockDispatchReview,
    reviewPassed: mockReviewPassed,
  },
}));

vi.mock('../../../utils/toast', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, info: mockToastInfo },
}));

import { DeliveryPanel } from '../DeliveryPanel';
import type { DeliveryStatus } from '../../../api';

// 台账 fixture：auto-merge / 在途 1 个 / wu-3 缺 L2
const baseDelivery: DeliveryStatus = {
  projectId: 'p1',
  pmoNumber: 'PMO-11',
  branch: 'PMO-11',
  policy: 'auto-merge',
  gitRepo: '/root/projects/studio',
  wu: {
    total: 3,
    finished: 2,
    inFlight: 1,
    byStatus: { unassigned: 0, active: 1, inReview: 0, blocked: 0 },
  },
  evidence: { l1Missing: [], l2Missing: ['wu-3'], l3Missing: [], selfReviewCount: 2 },
  deliverable: false,
  missing: ['wu-3 缺 L2 agent 评审'],
  tokens: 1234,
  archived: false,
  gaps: [{ id: 'wu-3', title: '实现交付台账', type: 'task', missing: ['l2'] }],
  deliveredAt: null,
  deliveredBy: null,
  deliverCommit: null,
};

const gapDelivery = (missing: Array<'l1' | 'l2' | 'l3'>): DeliveryStatus => ({
  ...baseDelivery,
  wu: { total: 1, finished: 1, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
  gaps: [{ id: 'wu-1', title: '修复登录缺陷', type: 'bug', missing }],
});

const renderPanel = (delivery: DeliveryStatus = baseDelivery, onRefresh = vi.fn()) =>
  render(<DeliveryPanel projectId="p1" delivery={delivery} onRefresh={onRefresh} />);

describe('DeliveryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliver.mockResolvedValue({ data: { delivered: true, deliverCommit: 'abcdef1234567890' } });
    mockVerify.mockResolvedValue({ data: { verified: true, report: { commands: ['pnpm test'] } } });
    mockDispatchReview.mockResolvedValue({ data: { reviewWorkUnitId: 'rw-1' } });
    mockReviewPassed.mockResolvedValue({ data: {} });
  });

  it('渲染台账概览 + 在途徽标 + 缺口行动行（缺层人话文案 + 行动按钮）', () => {
    renderPanel();

    expect(screen.getByText('交付', { selector: 'h3' })).toBeTruthy();
    expect(screen.getByText('🔄 进行中 2/3')).toBeTruthy();
    // #399 §8.3 词表：WU→任务；证据三级白话
    expect(screen.getByText('任务: 2/3 完成')).toBeTruthy();
    expect(screen.getByText('Agent 评审: 缺 1')).toBeTruthy();
    expect(screen.getByText('实现交付台账')).toBeTruthy();
    expect(screen.getByText('缺 Agent 评审')).toBeTruthy();
    expect(screen.getByRole('button', { name: '派发评审' })).toBeTruthy();
  });

  it('「查看任务 ›」跳转 /workunits/:id', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '查看任务 ›' }));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-3');
  });

  it('#376 归档口径：archived 零任务 → 「任务明细已归档」替代「无关联任务」', () => {
    renderPanel({
      ...baseDelivery,
      archived: true,
      wu: { total: 0, finished: 0, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
      missing: ['无关联任务'],
      gaps: [],
    });
    expect(screen.getByText(/任务明细已归档/)).toBeTruthy();
    expect(screen.queryByText('无关联任务')).toBeNull();
  });

  it('#376 归档口径：非 archived 零任务 → 仍显示「无关联任务」', () => {
    renderPanel({
      ...baseDelivery,
      wu: { total: 0, finished: 0, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
      missing: ['无关联任务'],
      gaps: [],
    });
    expect(screen.getByText('无关联任务')).toBeTruthy();
    expect(screen.queryByText(/任务明细已归档/)).toBeNull();
  });

  // ---- handleGapAction 状态码 → toast 矩阵 ----

  it('verify 成功（verified=true）：success toast + onRefresh', async () => {
    const onRefresh = vi.fn();
    renderPanel(gapDelivery(['l1']), onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '重跑验证' }));

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('wu-1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('验证通过，自动验证已补齐'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('verify 未通过（verified=false）：error toast 带失败命令，不刷新', async () => {
    mockVerify.mockResolvedValue({
      data: { verified: false, failed: [{ command: 'pnpm test' }, { command: 'pnpm lint' }] },
    });
    const onRefresh = vi.fn();
    renderPanel(gapDelivery(['l1']), onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '重跑验证' }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('验证未通过：pnpm test；pnpm lint'));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('verify 422：error toast 用 hint（缺省回退「未配置验证命令」）', async () => {
    mockVerify.mockRejectedValue({ response: { status: 422, data: { hint: '请配置 verifyCommands' } } });
    renderPanel(gapDelivery(['l1']));

    fireEvent.click(screen.getByRole('button', { name: '重跑验证' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('请配置 verifyCommands'));
  });

  it('verify 422 无 hint：error toast 回退默认文案', async () => {
    mockVerify.mockRejectedValue({ response: { status: 422, data: {} } });
    renderPanel(gapDelivery(['l1']));

    fireEvent.click(screen.getByRole('button', { name: '重跑验证' }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('未配置验证命令（verifyCommands）'));
  });

  it('verify 409：error toast 用 error.message（缺省回退「无 worktree」）', async () => {
    mockVerify.mockRejectedValue({
      response: { status: 409, data: { error: { message: 'worktree 已清理' } } },
    });
    renderPanel(gapDelivery(['l1']));

    fireEvent.click(screen.getByRole('button', { name: '重跑验证' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('worktree 已清理'));
  });

  it('dispatchReview 409：info toast「评审已在途或已完成」（非 error）', async () => {
    mockDispatchReview.mockRejectedValue({ response: { status: 409, data: {} } });
    renderPanel(gapDelivery(['l2']));

    fireEvent.click(screen.getByRole('button', { name: '派发评审' }));

    await waitFor(() => expect(mockToastInfo).toHaveBeenCalledWith('评审已在途或已完成'));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('dispatchReview 成功：success toast + onRefresh', async () => {
    const onRefresh = vi.fn();
    renderPanel(gapDelivery(['l2']), onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '派发评审' }));

    await waitFor(() => expect(mockDispatchReview).toHaveBeenCalledWith('wu-1'));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('已创建评审任务，待 agent 领取'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('reviewPassed 成功：success toast + onRefresh', async () => {
    const onRefresh = vi.fn();
    renderPanel(gapDelivery(['l3']), onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '人工确认' }));

    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined, undefined));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('人工确认已补齐'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('analysis 缺口（#106 M7；#463 结构化表单）：人工确认走共享弹窗——拉 WU 详情预填清单，人改后 confirm 载荷随 reviewPassed 回传', async () => {
    mockWuGet.mockResolvedValue({
      data: { metadata: JSON.stringify({ analysisFog: ['存储选型用哪个？'], analysisTasks: ['实现存储层'] }) },
    });
    const onRefresh = vi.fn();
    renderPanel({
      ...gapDelivery(['l3']),
      gaps: [{ id: 'wu-a1', title: '分析存储选型', type: 'analysis', missing: ['l3'] }],
    }, onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '人工确认' }));

    expect(await screen.findByLabelText('待决问题 1')).toBeTruthy();
    expect(mockWuGet).toHaveBeenCalledWith('wu-a1');
    expect((screen.getByLabelText('待决问题 1') as HTMLInputElement).value).toBe('存储选型用哪个？');
    expect((screen.getByLabelText('派工任务 1') as HTMLInputElement).value).toBe('实现存储层');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('待决问题 1'), { target: { value: '改后的待决问题？' } });
    fireEvent.click(screen.getByText('确认开图'));

    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-a1', undefined, undefined, {
      kind: 'analysis', fog: ['改后的待决问题？'], tasks: ['实现存储层'],
    }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('人工确认已补齐'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('#471 plan 缺口：人工确认同样走共享弹窗，confirm kind=plan 回传', async () => {
    mockWuGet.mockResolvedValue({
      data: { metadata: JSON.stringify({ analysisFog: ['存储选型用哪个？'], analysisTasks: ['实现存储层'] }) },
    });
    const onRefresh = vi.fn();
    renderPanel({
      ...gapDelivery(['l3']),
      gaps: [{ id: 'wu-p1', title: '规划存储选型', type: 'plan', missing: ['l3'] }],
    }, onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '人工确认' }));

    expect(await screen.findByLabelText('待决问题 1')).toBeTruthy();
    expect(mockWuGet).toHaveBeenCalledWith('wu-p1');

    fireEvent.click(screen.getByText('确认开图'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-p1', undefined, undefined, {
      kind: 'plan', fog: ['存储选型用哪个？'], tasks: ['实现存储层'],
    }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('兜底分支：非矩阵状态码 error toast 用 error.message，再次缺省回退「操作失败」', async () => {
    mockReviewPassed.mockRejectedValue({
      response: { status: 500, data: { error: { message: '服务器内部错误' } } },
    });
    renderPanel(gapDelivery(['l3']));

    fireEvent.click(screen.getByRole('button', { name: '人工确认' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('服务器内部错误'));
  });

  // ---- handleDeliver ----

  it('deliver 成功：success toast 带 commit 短哈希 + onRefresh', async () => {
    const onRefresh = vi.fn();
    renderPanel({ ...baseDelivery, deliverable: true, gaps: [] }, onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '交付合并' }));

    await waitFor(() => expect(mockDeliver).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('交付成功 (abcdef1)'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('deliver 409：内联展示 missing / conflictFiles，不发 toast', async () => {
    mockDeliver.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error: {
            code: 'EVIDENCE_MISSING',
            message: '证据不齐，拒绝合并',
            missing: ['WU-3 缺 L1 自动验证'],
            conflictFiles: ['src/a.ts'],
          },
        },
      },
    });
    renderPanel({ ...baseDelivery, deliverable: true, gaps: [] });

    fireEvent.click(screen.getByRole('button', { name: '交付合并' }));

    await waitFor(() => expect(screen.getByText('证据不齐，拒绝合并')).toBeTruthy());
    expect(screen.getByText('WU-3 缺 L1 自动验证')).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('deliver 非 409：error toast 用 error.message', async () => {
    mockDeliver.mockRejectedValue({
      response: { status: 500, data: { error: { message: '合并超时' } } },
    });
    renderPanel({ ...baseDelivery, deliverable: true, gaps: [] });

    fireEvent.click(screen.getByRole('button', { name: '交付合并' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('合并超时'));
  });

  it('branch-only：deliverable 且未交付时显示合并提示，无交付按钮', () => {
    renderPanel({ ...baseDelivery, policy: 'branch-only', deliverable: true, gaps: [] });

    expect(screen.getByText(/证据已齐:请合并分支 PMO-11 并走下游发布链路/)).toBeTruthy();
    expect(screen.queryByText('交付合并')).toBeNull();
  });

  // ---- #469 branch-only 标记已交付 ----

  const branchOnlyDelivery: DeliveryStatus = {
    ...baseDelivery,
    policy: 'branch-only',
    deliverable: true,
    gaps: [],
  };

  it('#469 branch-only 未交付：渲染 commit 输入 + 「标记已交付」按钮；已交付则不渲染', () => {
    renderPanel(branchOnlyDelivery);
    expect(screen.getByLabelText('合并 commit 哈希')).toBeTruthy();
    expect(screen.getByRole('button', { name: '标记已交付' })).toBeTruthy();

    renderPanel({ ...branchOnlyDelivery, deliveredAt: '2026-09-09T00:00:00Z', deliverCommit: 'c0ffee1' });
    expect(screen.queryAllByLabelText('合并 commit 哈希')).toHaveLength(1); // 仅第一处渲染
  });

  it('#469 标记已交付成功：trim 后提交，success toast 带短哈希 + onRefresh + 清空输入', async () => {
    mockMarkDelivered.mockResolvedValue({ data: { delivered: true, deliverCommit: 'c0ffee1234', deliveredAt: '2026-09-09T00:00:00Z' } });
    const onRefresh = vi.fn();
    renderPanel(branchOnlyDelivery, onRefresh);

    fireEvent.change(screen.getByLabelText('合并 commit 哈希'), { target: { value: '  c0ffee1234  ' } });
    fireEvent.click(screen.getByRole('button', { name: '标记已交付' }));

    await waitFor(() => expect(mockMarkDelivered).toHaveBeenCalledWith('p1', 'c0ffee1234'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('已标记交付 (c0ffee1)'));
    expect(onRefresh).toHaveBeenCalled();
    expect((screen.getByLabelText('合并 commit 哈希') as HTMLInputElement).value).toBe('');
  });

  it('#469 空 commit 不提交（按钮禁用）', () => {
    renderPanel(branchOnlyDelivery);
    expect((screen.getByRole('button', { name: '标记已交付' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockMarkDelivered).not.toHaveBeenCalled();
  });

  it('#469 标记已交付 409：error toast 用 error.message，不刷新', async () => {
    mockMarkDelivered.mockRejectedValue({
      response: { status: 409, data: { error: { message: '已于 2026-09-01 落档' } } },
    });
    const onRefresh = vi.fn();
    renderPanel(branchOnlyDelivery, onRefresh);

    fireEvent.change(screen.getByLabelText('合并 commit 哈希'), { target: { value: 'c0ffee' } });
    fireEvent.click(screen.getByRole('button', { name: '标记已交付' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('已于 2026-09-01 落档'));
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
