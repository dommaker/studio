// GcProposalCard — #144 知识库 GC 候选清单人审闸口
// 契约：cardType 'gc_proposal'；action 'gc_proposal_approve' / 'gc_proposal_reject'
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GcProposalCard } from '../GcProposalCard';
import { distillApi } from '../../../api/distill';
import type { ChannelMessage } from '../../../api/channel';

// 已审态按提案状态派生：默认 pending（保持待审），各用例按需覆盖
vi.mock('../../../api/distill', () => ({
  distillApi: { gcProposalStatus: vi.fn() },
}));
const mockGcProposalStatus = distillApi.gcProposalStatus as ReturnType<typeof vi.fn>;

const baseMessage: ChannelMessage = {
  id: 'msg-gc-1',
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'KK',
  content: '知识库 GC 候选清单 — 待确认',
  replyToId: null,
  meta: JSON.stringify({
    cardType: 'gc_proposal',
    status: 'ready',
    cardData: {
      gcProposalId: 'gc-1',
      runId: 'run-1',
      forced: false,
      mainAreaCount: 42,
      candidates: [
        { entryId: 'e-1', title: '过时的部署笔记', reason: '连续 3 个蒸馏周期零引用（lastReferenced 停留在 2026-06-01；零引用周期：2026-07-01、2026-07-15、2026-08-01）' },
        { entryId: 'e-2', title: '旧的鉴权约定', reason: '连续 4 个蒸馏周期零引用（lastReferenced 停留在 2026-05-20；零引用周期：2026-07-01、2026-07-15、2026-08-01）' },
      ],
    },
  }),
  createdAt: new Date().toISOString(),
};

describe('GcProposalCard — GC 候选清单人审闸口', () => {
  beforeEach(() => {
    mockGcProposalStatus.mockReset();
    mockGcProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'gc-1': 'pending' } } });
  });

  it('renders 候选清单（逐条理由）+ 确认归档/全部保留按钮', () => {
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(screen.getByText('过时的部署笔记')).toBeTruthy();
    expect(screen.getByText('旧的鉴权约定')).toBeTruthy();
    expect(screen.getAllByText(/连续 3 个蒸馏周期零引用/).length).toBeGreaterThan(0);
    expect(screen.getByText(/连续 4 个蒸馏周期零引用/)).toBeTruthy();
    expect(screen.getByText('2 条候选')).toBeTruthy();
    expect(screen.getByText('确认归档')).toBeTruthy();
    expect(screen.getByText('全部保留')).toBeTruthy();
  });

  it('forced=true 时显示超容量强制说明', () => {
    const meta = JSON.parse(baseMessage.meta!);
    meta.cardData.forced = true;
    meta.cardData.mainAreaCount = 203;
    render(<GcProposalCard message={baseMessage} meta={meta} onAction={vi.fn()} />);
    expect(screen.getByText(/203 条已超容量上限/)).toBeTruthy();
  });

  it('锁存（#288 核查）：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    const approveBtn = screen.getByText('确认归档').closest('button')!;
    fireEvent.click(approveBtn);
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText('全部保留').closest('button')!.disabled).toBe(true);
    fireEvent.click(approveBtn);
    fireEvent.click(screen.getByText('全部保留'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText(/已确认，候选条目已归档/)).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('点确认归档 → onAction(messageId, gc_proposal_approve)，成功后显示已归档', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认归档'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-gc-1', 'gc_proposal_approve'));
    expect(await screen.findByText(/已确认，候选条目已归档/)).toBeTruthy();
  });

  it('点全部保留 → onAction(messageId, gc_proposal_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('全部保留'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-gc-1', 'gc_proposal_reject'));
    expect(await screen.findByText(/已拒绝，条目全部保留/)).toBeTruthy();
  });

  it('onAction 返回 false → 不显示已审态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认归档'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认归档')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('刷新后按提案状态派生已审态：executed → 已归档（无按钮）', async () => {
    mockGcProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'gc-1': 'executed' } } });
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已确认，候选条目已归档/)).toBeTruthy();
    expect(screen.queryByText('全部保留')).not.toBeTruthy();
    expect(mockGcProposalStatus).toHaveBeenCalledWith(['gc-1']);
  });

  it('刷新后按提案状态派生已审态：rejected → 已拒绝', async () => {
    mockGcProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'gc-1': 'rejected' } } });
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已拒绝，条目全部保留/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockGcProposalStatus.mockRejectedValue(new Error('network'));
    render(<GcProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    await waitFor(() => expect(mockGcProposalStatus).toHaveBeenCalled());
    expect(screen.getByText('确认归档')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});
