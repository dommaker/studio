// ConstraintAuditCard — #146 存量约束退役建议人审闸口
// 契约：cardType 'constraint_audit_proposal'；action 'constraint_audit_approve' / 'constraint_audit_reject'
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConstraintAuditCard } from '../ConstraintAuditCard';
import { distillApi } from '../../../api/distill';
import type { ChannelMessage } from '../../../api/channel';

// 已审态按提案状态派生：默认 pending（保持待审），各用例按需覆盖
vi.mock('../../../api/distill', () => ({
  distillApi: { auditProposalStatus: vi.fn() },
}));
const mockAuditProposalStatus = distillApi.auditProposalStatus as ReturnType<typeof vi.fn>;

const baseMessage: ChannelMessage = {
  id: 'msg-audit-1',
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'KK',
  content: '存量约束退役建议 — 待确认',
  replyToId: null,
  meta: JSON.stringify({
    cardType: 'constraint_audit_proposal',
    status: 'ready',
    cardData: {
      auditProposalId: 'audit-1',
      runId: 'run-1',
      auditedCount: 7,
      suggestions: [
        { constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已从代码库删除' },
        { constraintId: 'old_deploy_rule', category: 'reintroduction-sealed', rationale: '部署拦截层已覆盖该风险' },
      ],
    },
  }),
  createdAt: new Date().toISOString(),
};

describe('ConstraintAuditCard — 存量约束退役建议人审闸口', () => {
  beforeEach(() => {
    mockAuditProposalStatus.mockReset();
    mockAuditProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'audit-1': 'pending' } } });
  });

  it('renders 建议清单（逐条判据+理由）+ 确认退役/全部保留按钮', () => {
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(screen.getByText('prisma_schema_needs_migration')).toBeTruthy();
    expect(screen.getByText('old_deploy_rule')).toBeTruthy();
    expect(screen.getByText('作用对象已消失')).toBeTruthy();
    expect(screen.getByText('再引入路径已封死')).toBeTruthy();
    expect(screen.getByText(/schema.prisma 已从代码库删除/)).toBeTruthy();
    expect(screen.getByText('2 条建议')).toBeTruthy();
    expect(screen.getByText('确认退役')).toBeTruthy();
    expect(screen.getByText('全部保留')).toBeTruthy();
  });

  it('点确认退役 → 两步确认（#288）：首次进入待确认态，再次点击才 onAction(constraint_audit_approve)，成功后显示已退役', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认退役'));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/再次点击确认退役/));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-audit-1', 'constraint_audit_approve'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已确认，建议约束已退役/)).toBeTruthy();
  });

  it('待确认态点全部保留 → 退出待确认态并单击直达 constraint_audit_reject', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认退役'));
    expect(screen.getByText(/再次点击确认退役/)).toBeTruthy();
    fireEvent.click(screen.getByText('全部保留'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-audit-1', 'constraint_audit_reject'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已拒绝，约束全部保留/)).toBeTruthy();
  });

  it('锁存（#288）：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认退役'));
    fireEvent.click(screen.getByText(/再次点击确认退役/));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    const armedBtn = screen.getByText(/再次点击确认退役/).closest('button')!;
    expect(armedBtn.disabled).toBe(true);
    expect(screen.getByText('全部保留').closest('button')!.disabled).toBe(true);
    fireEvent.click(armedBtn);
    fireEvent.click(screen.getByText('全部保留'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText(/已确认，建议约束已退役/)).toBeTruthy();
  });

  it('点全部保留 → onAction(messageId, constraint_audit_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('全部保留'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-audit-1', 'constraint_audit_reject'));
    expect(await screen.findByText(/已拒绝，约束全部保留/)).toBeTruthy();
  });

  it('onAction 返回 false → 不显示已审态，退出待确认态且按钮仍可点（失败重武装）', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认退役'));
    fireEvent.click(screen.getByText(/再次点击确认退役/));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认退役').closest('button')!.disabled).toBe(false));
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('刷新后按提案状态派生已审态：executed → 已退役（无按钮）', async () => {
    mockAuditProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'audit-1': 'executed' } } });
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已确认，建议约束已退役/)).toBeTruthy();
    expect(screen.queryByText('全部保留')).not.toBeTruthy();
    expect(mockAuditProposalStatus).toHaveBeenCalledWith(['audit-1']);
  });

  it('刷新后按提案状态派生已审态：rejected → 已拒绝', async () => {
    mockAuditProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'audit-1': 'rejected' } } });
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已拒绝，约束全部保留/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockAuditProposalStatus.mockRejectedValue(new Error('network'));
    render(<ConstraintAuditCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    await waitFor(() => expect(mockAuditProposalStatus).toHaveBeenCalled());
    expect(screen.getByText('确认退役')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});
