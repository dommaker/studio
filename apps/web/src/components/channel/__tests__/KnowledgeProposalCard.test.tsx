// KnowledgeProposalCard — 2026-07 知识审核闭环
// 契约（γ 轨道依赖）：cardType 'knowledge_proposal'；
// action 'knowledge_proposal_approve' / 'knowledge_proposal_reject'
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KnowledgeProposalCard } from '../KnowledgeProposalCard';
import { knowledgeApi } from '../../../api/knowledge';
import type { ChannelMessage } from '../../../api/channel';

// 已审核态按条目 maturity 派生：默认全部 draft（保持待审），各用例按需覆盖
vi.mock('../../../api/knowledge', () => ({
  knowledgeApi: { getEntry: vi.fn() },
}));
const mockGetEntry = knowledgeApi.getEntry as ReturnType<typeof vi.fn>;

const baseMessage: ChannelMessage = {
  id: 'msg-kp-1',
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'KK',
  content: '知识提案 — 待人工审核',
  replyToId: null,
  meta: JSON.stringify({
    cardType: 'knowledge_proposal',
    status: 'ready',
    cardData: {
      workUnitId: 'WU-2042',
      entries: [
        { id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' },
        { id: 'k-2', title: '登录流程统一走 auth-service', type: 'guideline' },
      ],
    },
  }),
  createdAt: new Date().toISOString(),
};

describe('KnowledgeProposalCard — 知识审核闭环', () => {
  beforeEach(() => {
    mockGetEntry.mockReset();
    mockGetEntry.mockResolvedValue({ data: { maturity: 'draft' } });
  });

  it('renders 条目标题/类型 + 通过/拒绝按钮', () => {
    render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(screen.getByText('session 过期未刷新导致 401')).toBeTruthy();
    expect(screen.getByText('登录流程统一走 auth-service')).toBeTruthy();
    expect(screen.getByText('2 条知识')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText(/WU-2042/)).toBeTruthy();
  });

  it('点通过 → onAction(messageId, knowledge_proposal_approve)，成功后显示已审核状态', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('通过'));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('msg-kp-1', 'knowledge_proposal_approve');
    });
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(screen.queryByText('通过')).not.toBeTruthy();
  });

  it('点拒绝 → onAction(messageId, knowledge_proposal_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('msg-kp-1', 'knowledge_proposal_reject');
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });

  it('onAction 返回 false（API 失败）→ 不显示已审核状态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('通过'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('通过')).toBeTruthy());
    expect(screen.queryByText(/已通过/)).not.toBeTruthy();
  });

  it('meta.status 已为 approved → 直接渲染已审核状态（无按钮）', () => {
    const meta = { ...JSON.parse(baseMessage.meta!), status: 'approved' };
    render(<KnowledgeProposalCard message={baseMessage} meta={meta} onAction={vi.fn()} />);
    expect(screen.getByText(/已通过/)).toBeTruthy();
    expect(screen.queryByText('拒绝')).not.toBeTruthy();
  });

  it('maturity 派生：条目全部 verified → 刷新后也显示已通过', async () => {
    mockGetEntry.mockResolvedValue({ data: { maturity: 'verified' } });
    render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(screen.queryByText('拒绝')).not.toBeTruthy();
  });

  it('maturity 派生：条目全部 archived → 显示已拒绝；混合状态保持待审', async () => {
    mockGetEntry.mockResolvedValue({ data: { maturity: 'archived' } });
    const { unmount } = render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
    unmount();

    mockGetEntry
      .mockResolvedValueOnce({ data: { maturity: 'draft' } })
      .mockResolvedValueOnce({ data: { maturity: 'verified' } });
    render(<KnowledgeProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    await waitFor(() => expect(mockGetEntry).toHaveBeenCalledTimes(4));
    expect(screen.getByText('通过')).toBeTruthy();
  });
});
