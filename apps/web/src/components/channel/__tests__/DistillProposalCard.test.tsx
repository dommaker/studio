// DistillProposalCard — #143 蒸馏提案人审闸口
// 契约：cardType 'distill_proposal'；action 'distill_proposal_approve' / 'distill_proposal_reject'
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DistillProposalCard } from '../DistillProposalCard';
import { distillApi } from '../../../api/distill';
import type { ChannelMessage } from '../../../api/channel';

// 已审态按提案状态派生：默认 pending（保持待审），各用例按需覆盖
vi.mock('../../../api/distill', () => ({
  distillApi: { proposalStatus: vi.fn() },
}));
const mockProposalStatus = distillApi.proposalStatus as ReturnType<typeof vi.fn>;

const baseMessage: ChannelMessage = {
  id: 'msg-dp-1',
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'KK',
  content: '知识蒸馏提案 — 待确认',
  replyToId: null,
  meta: JSON.stringify({
    cardType: 'distill_proposal',
    status: 'ready',
    cardData: {
      proposalId: 'dp-1',
      workUnitId: 'WU-2042',
      signals: { topicTags: ['session-summary'], manualCount: 0 },
      materials: [
        { id: 'ore-1', title: '[Session Fix] 修复竞态' },
        { id: 'ore-2', title: '[Session Fix] 修复超时' },
        { id: 'ore-3', title: '[Session Feature] 新增导出' },
      ],
    },
  }),
  createdAt: new Date().toISOString(),
};

describe('DistillProposalCard — 蒸馏提案人审闸口', () => {
  beforeEach(() => {
    mockProposalStatus.mockReset();
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'pending' } } });
  });

  it('renders 原料清单/命中信号 + 确认蒸馏/拒绝按钮', () => {
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(screen.getByText('[Session Fix] 修复竞态')).toBeTruthy();
    expect(screen.getByText('[Session Fix] 修复超时')).toBeTruthy();
    expect(screen.getByText('[Session Feature] 新增导出')).toBeTruthy();
    expect(screen.getByText(/session-summary/)).toBeTruthy();
    expect(screen.getByText('3 条原料')).toBeTruthy();
    expect(screen.getByText('确认蒸馏')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('点确认蒸馏 → onAction(messageId, distill_proposal_approve)，成功后显示已执行', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认蒸馏'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-dp-1', 'distill_proposal_approve'));
    expect(await screen.findByText(/已确认，蒸馏已执行/)).toBeTruthy();
  });

  it('点拒绝 → onAction(messageId, distill_proposal_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-dp-1', 'distill_proposal_reject'));
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });

  it('onAction 返回 false（如预算熔断）→ 不显示已审态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认蒸馏'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认蒸馏')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('刷新后按提案状态派生已审态：executed → 已执行（无按钮）', async () => {
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'executed' } } });
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已确认，蒸馏已执行/)).toBeTruthy();
    expect(screen.queryByText('拒绝')).not.toBeTruthy();
    expect(mockProposalStatus).toHaveBeenCalledWith(['dp-1']);
  });

  it('刷新后按提案状态派生已审态：rejected → 已拒绝；failed → 执行失败', async () => {
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'rejected' } } });
    const { unmount } = render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
    unmount();

    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'failed' } } });
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/执行失败/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockProposalStatus.mockRejectedValue(new Error('network'));
    render(<DistillProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    await waitFor(() => expect(mockProposalStatus).toHaveBeenCalled());
    expect(screen.getByText('确认蒸馏')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});
