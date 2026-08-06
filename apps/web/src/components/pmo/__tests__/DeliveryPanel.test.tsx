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
  mockVerify,
  mockDispatchReview,
  mockReviewPassed,
  mockToastSuccess,
  mockToastError,
  mockToastInfo,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockDeliver: vi.fn(),
  mockVerify: vi.fn(),
  mockDispatchReview: vi.fn(),
  mockReviewPassed: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../api', () => ({
  projectApi: { deliver: mockDeliver },
}));

vi.mock('../../../api/workunit', () => ({
  workunitApi: {
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

    expect(screen.getByText('📦 交付')).toBeTruthy();
    expect(screen.getByText('🔄 进行中 2/3')).toBeTruthy();
    expect(screen.getByText('WU: 2/3 完成')).toBeTruthy();
    expect(screen.getByText('L2: 缺 1')).toBeTruthy();
    expect(screen.getByText('实现交付台账')).toBeTruthy();
    expect(screen.getByText('缺 L2 agent 评审')).toBeTruthy();
    expect(screen.getByRole('button', { name: '派发评审' })).toBeTruthy();
  });

  it('「查看 WU ›」跳转 /workunits/:id', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '查看 WU ›' }));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-3');
  });

  // ---- handleGapAction 状态码 → toast 矩阵 ----

  it('verify 成功（verified=true）：success toast + onRefresh', async () => {
    const onRefresh = vi.fn();
    renderPanel(gapDelivery(['l1']), onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '重跑验证' }));

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('wu-1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('验证通过，L1 已补齐'));
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
      expect(mockToastSuccess).toHaveBeenCalledWith('已创建评审 WorkUnit，待 agent 认领'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('reviewPassed 成功：success toast + onRefresh', async () => {
    const onRefresh = vi.fn();
    renderPanel(gapDelivery(['l3']), onRefresh);

    fireEvent.click(screen.getByRole('button', { name: '人工确认' }));

    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('已确认，L3 已补齐'));
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
});
