// useChannelCardActions（#322）：卡片 action 类型 → api 调用映射表测试。
// 断言自 ChannelDetailPage handleAction 现状反推：各 action 分发到哪个 api、带什么参数、
// 缺 cardData 返回 false、成功后 refresh、异常返回 false。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const {
  mockPromote, mockDemote,
  mockMemPromote, mockMemDemote,
  mockDistillApprove, mockDistillReject,
  mockGcApprove, mockGcReject,
  mockAuditApprove, mockAuditReject,
  mockCardDecision, mockRetractDecide,
} = vi.hoisted(() => ({
  mockPromote: vi.fn(),
  mockDemote: vi.fn(),
  mockMemPromote: vi.fn(),
  mockMemDemote: vi.fn(),
  mockDistillApprove: vi.fn(),
  mockDistillReject: vi.fn(),
  mockGcApprove: vi.fn(),
  mockGcReject: vi.fn(),
  mockAuditApprove: vi.fn(),
  mockAuditReject: vi.fn(),
  mockCardDecision: vi.fn(),
  mockRetractDecide: vi.fn(),
}));

vi.mock('../../api/knowledge', () => ({ knowledgeApi: { promote: mockPromote, demote: mockDemote } }));
vi.mock('../../api/memory', () => ({ memoryApi: { promote: mockMemPromote, demote: mockMemDemote } }));
vi.mock('../../api/distill', () => ({
  distillApi: {
    approve: mockDistillApprove, reject: mockDistillReject,
    gcApprove: mockGcApprove, gcReject: mockGcReject,
    auditApprove: mockAuditApprove, auditReject: mockAuditReject,
  },
}));
vi.mock('../../api/skills', () => ({ skillsApi: { retractDecide: mockRetractDecide } }));
vi.mock('../../api/channel', () => ({ channelApi: { cardDecision: mockCardDecision } }));

import { useChannelCardActions } from '../useChannelCardActions';
import type { ChannelMessage } from '../../api/channel';

const msg = (id: string, cardData?: Record<string, unknown>): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
  content: `卡片-${id}`, replyToId: null,
  meta: cardData ? { cardType: 'x', cardData } : '{}',
  createdAt: '2026-08-19T10:00:00.000Z',
});

const setup = (messages: ChannelMessage[], channelId: string | undefined = 'ch-1') => {
  const refresh = vi.fn();
  const { result, rerender } = renderHook(
    (props: { messages: ChannelMessage[] }) =>
      useChannelCardActions({ channelId, messages: props.messages, refresh }),
    { initialProps: { messages } },
  );
  return { dispatch: () => result.current, refresh, rerender };
};

describe('useChannelCardActions — action → api 映射', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromote.mockResolvedValue({});
    mockDemote.mockResolvedValue({});
    mockMemPromote.mockResolvedValue({});
    mockMemDemote.mockResolvedValue({});
    mockDistillApprove.mockResolvedValue({ data: { success: true } });
    mockDistillReject.mockResolvedValue({});
    mockGcApprove.mockResolvedValue({ data: { success: true } });
    mockGcReject.mockResolvedValue({});
    mockAuditApprove.mockResolvedValue({ data: { success: true } });
    mockAuditReject.mockResolvedValue({});
    mockCardDecision.mockResolvedValue({});
    mockRetractDecide.mockResolvedValue({});
  });

  it('converted → 仅 refresh，不调任何 api，返回 true', async () => {
    const { dispatch, refresh } = setup([msg('m1')]);
    await expect(dispatch()('m1', 'converted')).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockCardDecision).not.toHaveBeenCalled();
  });

  it('knowledge_proposal_approve → knowledgeApi.promote 逐 entryId；reject → demote', async () => {
    const messages = [msg('m1', { entries: [{ id: 'k-1' }, { id: 'k-2' }] })];
    const { dispatch, refresh } = setup(messages);
    await expect(dispatch()('m1', 'knowledge_proposal_approve')).resolves.toBe(true);
    expect(mockPromote).toHaveBeenCalledWith('k-1');
    expect(mockPromote).toHaveBeenCalledWith('k-2');
    expect(refresh).toHaveBeenCalledTimes(1);

    await expect(dispatch()('m1', 'knowledge_proposal_reject')).resolves.toBe(true);
    expect(mockDemote).toHaveBeenCalledWith('k-1');
    expect(mockDemote).toHaveBeenCalledWith('k-2');
  });

  it('knowledge_proposal：entries 缺/空 → false 且不调 api', async () => {
    const { dispatch, refresh } = setup([msg('m1', {}), msg('m2')]);
    await expect(dispatch()('m1', 'knowledge_proposal_approve')).resolves.toBe(false);
    await expect(dispatch()('m2', 'knowledge_proposal_approve')).resolves.toBe(false);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('memory_proposal_approve → memoryApi.promote(roleId, draftIds)；reject → demote', async () => {
    const messages = [msg('m1', { roleId: 'r-1', entries: [{ draftId: 'd-1' }, { draftId: 'd-2' }] })];
    const { dispatch } = setup(messages);
    await expect(dispatch()('m1', 'memory_proposal_approve')).resolves.toBe(true);
    expect(mockMemPromote).toHaveBeenCalledWith('r-1', ['d-1', 'd-2']);
    await expect(dispatch()('m1', 'memory_proposal_reject')).resolves.toBe(true);
    expect(mockMemDemote).toHaveBeenCalledWith('r-1', ['d-1', 'd-2']);
  });

  it('memory_proposal：缺 roleId → false', async () => {
    const { dispatch } = setup([msg('m1', { entries: [{ draftId: 'd-1' }] })]);
    await expect(dispatch()('m1', 'memory_proposal_approve')).resolves.toBe(false);
    expect(mockMemPromote).not.toHaveBeenCalled();
  });

  it('distill_proposal_approve → distillApi.approve；success=false → 返回 false 不 refresh；reject → distillApi.reject', async () => {
    const messages = [msg('m1', { proposalId: 'p-1' })];
    const { dispatch, refresh } = setup(messages);
    await expect(dispatch()('m1', 'distill_proposal_approve')).resolves.toBe(true);
    expect(mockDistillApprove).toHaveBeenCalledWith('p-1');

    mockDistillApprove.mockResolvedValue({ data: { success: false } });
    await expect(dispatch()('m1', 'distill_proposal_approve')).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1); // 仅第一次成功 refresh

    await expect(dispatch()('m1', 'distill_proposal_reject')).resolves.toBe(true);
    expect(mockDistillReject).toHaveBeenCalledWith('p-1');
  });

  it('gc_proposal_approve/reject → distillApi.gcApprove/gcReject', async () => {
    const messages = [msg('m1', { gcProposalId: 'gc-1' })];
    const { dispatch } = setup(messages);
    await expect(dispatch()('m1', 'gc_proposal_approve')).resolves.toBe(true);
    expect(mockGcApprove).toHaveBeenCalledWith('gc-1');
    await expect(dispatch()('m1', 'gc_proposal_reject')).resolves.toBe(true);
    expect(mockGcReject).toHaveBeenCalledWith('gc-1');
  });

  it('constraint_audit_approve/reject → distillApi.auditApprove/auditReject', async () => {
    const messages = [msg('m1', { auditProposalId: 'a-1' })];
    const { dispatch } = setup(messages);
    await expect(dispatch()('m1', 'constraint_audit_approve')).resolves.toBe(true);
    expect(mockAuditApprove).toHaveBeenCalledWith('a-1');
    await expect(dispatch()('m1', 'constraint_audit_reject')).resolves.toBe(true);
    expect(mockAuditReject).toHaveBeenCalledWith('a-1');
  });

  it('auditor_apply_confirm/reject → channelApi.cardDecision(confirm/reject)', async () => {
    const { dispatch } = setup([msg('m1')]);
    await expect(dispatch()('m1', 'auditor_apply_confirm')).resolves.toBe(true);
    expect(mockCardDecision).toHaveBeenCalledWith('ch-1', 'm1', 'confirm');
    await expect(dispatch()('m1', 'auditor_apply_reject')).resolves.toBe(true);
    expect(mockCardDecision).toHaveBeenCalledWith('ch-1', 'm1', 'reject');
  });

  it('retract_confirm/reject → skillsApi.retractDecide(skillId, decision, messageId)', async () => {
    const messages = [msg('m1', { skillId: 'sk-1' })];
    const { dispatch } = setup(messages);
    await expect(dispatch()('m1', 'retract_confirm')).resolves.toBe(true);
    expect(mockRetractDecide).toHaveBeenCalledWith('sk-1', 'confirm', 'm1');
    await expect(dispatch()('m1', 'retract_reject')).resolves.toBe(true);
    expect(mockRetractDecide).toHaveBeenCalledWith('sk-1', 'reject', 'm1');
  });

  it('未知 action → false，不调任何 api', async () => {
    const { dispatch } = setup([msg('m1', { proposalId: 'p-1' })]);
    await expect(dispatch()('m1', 'nonexistent_action')).resolves.toBe(false);
    expect(mockDistillApprove).not.toHaveBeenCalled();
  });

  it('api 异常 → 返回 false（knowledge promote reject）', async () => {
    mockPromote.mockRejectedValue(new Error('boom'));
    const messages = [msg('m1', { entries: [{ id: 'k-1' }] })];
    const { dispatch, refresh } = setup(messages);
    await expect(dispatch()('m1', 'knowledge_proposal_approve')).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('meta 为 string（存量/夹具形态）同样解析 cardData', async () => {
    const m = msg('m1');
    m.meta = JSON.stringify({ cardType: 'x', cardData: { proposalId: 'p-9' } });
    const { dispatch } = setup([m]);
    await expect(dispatch()('m1', 'distill_proposal_reject')).resolves.toBe(true);
    expect(mockDistillReject).toHaveBeenCalledWith('p-9');
  });

  it('dispatch 引用稳定：messages 更新后 identity 不变，且读到最新 cardData', async () => {
    const { dispatch, rerender } = setup([msg('m1', { proposalId: 'p-1' })]);
    const before = dispatch();
    rerender({ messages: [msg('m1', { proposalId: 'p-2' })] });
    expect(dispatch()).toBe(before);
    await expect(dispatch()('m1', 'distill_proposal_reject')).resolves.toBe(true);
    expect(mockDistillReject).toHaveBeenCalledWith('p-2');
  });
});
