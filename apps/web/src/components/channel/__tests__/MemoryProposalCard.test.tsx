// MemoryProposalCard — #101 角色记忆人审闸口
// 契约：cardType 'memory_proposal'；action 'memory_proposal_approve' / 'memory_proposal_reject'
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryProposalCard } from '../MemoryProposalCard';
import type { ChannelMessage } from '../../../api/channel';

const baseMessage: ChannelMessage = {
  id: 'msg-mp-1',
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'KK',
  content: '角色记忆提案 — 待确认',
  replyToId: null,
  meta: JSON.stringify({
    cardType: 'memory_proposal',
    status: 'ready',
    cardData: {
      roleId: 'role-1',
      workUnitId: 'WU-2042',
      entries: [
        { draftId: 'd-1', title: '测试命令', topicSlug: 'testing-command', topicPath: 'topics/testing-command.md', kind: 'execution-knowledge' },
        { draftId: 'd-2', title: '命名约定', topicSlug: 'naming', topicPath: 'topics/naming.md', kind: 'preference' },
      ],
    },
  }),
  createdAt: new Date().toISOString(),
};

describe('MemoryProposalCard — 角色记忆人审闸口', () => {
  it('renders 标题/文件路径/人类可读标签 + 确认写入/丢弃按钮，无内部分类词', () => {
    render(<MemoryProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={vi.fn()} />);
    expect(screen.getByText('测试命令')).toBeTruthy();
    expect(screen.getByText('命名约定')).toBeTruthy();
    expect(screen.getByText('经验做法')).toBeTruthy();
    expect(screen.getByText('偏好约定')).toBeTruthy();
    expect(screen.getByText('将写入：topics/testing-command.md')).toBeTruthy();
    expect(screen.getByText('将写入：topics/naming.md')).toBeTruthy();
    expect(screen.getByText('确认写入')).toBeTruthy();
    expect(screen.getByText('丢弃')).toBeTruthy();
    expect(screen.queryByText(/execution-knowledge/)).not.toBeTruthy();
    expect(screen.queryByText(/preference/)).not.toBeTruthy();
    expect(screen.getByText(/WU-2042/)).toBeTruthy();
  });

  it('点确认写入 → onAction(messageId, memory_proposal_approve)，成功后显示已确认', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<MemoryProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认写入'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-mp-1', 'memory_proposal_approve'));
    expect(await screen.findByText(/已确认/)).toBeTruthy();
  });

  it('点丢弃 → onAction(messageId, memory_proposal_reject)，成功后显示已丢弃', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(<MemoryProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('丢弃'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-mp-1', 'memory_proposal_reject'));
    expect(await screen.findByText(/已丢弃/)).toBeTruthy();
  });

  it('onAction 返回 false → 不显示已审核状态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    render(<MemoryProposalCard message={baseMessage} meta={JSON.parse(baseMessage.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认写入'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认写入')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('meta.status 已为 approved → 直接渲染已确认（无按钮）', () => {
    const meta = { ...JSON.parse(baseMessage.meta!), status: 'approved' };
    render(<MemoryProposalCard message={baseMessage} meta={meta} onAction={vi.fn()} />);
    expect(screen.getByText(/已确认/)).toBeTruthy();
    expect(screen.queryByText('丢弃')).not.toBeTruthy();
  });
});
