// ReviewProposalCard — #352 人审提案卡合一壳（ADR 2026-08-25 决策 5）
// 等价替换旧 5 卡组件测试（Distill/Gc/Memory/Knowledge/ConstraintAudit），逐用例对照见 #352 交付摘要。
// 契约：5 个 cardType 共用本壳；action/终态文案/按钮文案/派生失败保持待审 逐字保持旧行为。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewProposalCard } from '../ReviewProposalCard';
import { distillApi } from '../../../api/distill';
import { memoryApi } from '../../../api/memory';
import { knowledgeApi } from '../../../api/knowledge';
import type { ChannelMessage } from '../../../api/channel';

// 已审态挂载期派生的数据源全部 mock：默认 pending/draft（保持待审），各用例按需覆盖
vi.mock('../../../api/distill', () => ({
  distillApi: { proposalStatus: vi.fn(), gcProposalStatus: vi.fn(), auditProposalStatus: vi.fn() },
}));
vi.mock('../../../api/memory', () => ({
  memoryApi: { draftStatus: vi.fn() },
}));
vi.mock('../../../api/knowledge', () => ({
  knowledgeApi: { getEntry: vi.fn() },
}));
const mockProposalStatus = distillApi.proposalStatus as ReturnType<typeof vi.fn>;
const mockGcProposalStatus = distillApi.gcProposalStatus as ReturnType<typeof vi.fn>;
const mockAuditProposalStatus = distillApi.auditProposalStatus as ReturnType<typeof vi.fn>;
const mockDraftStatus = memoryApi.draftStatus as ReturnType<typeof vi.fn>;
const mockGetEntry = knowledgeApi.getEntry as ReturnType<typeof vi.fn>;

const msg = (id: string, content: string, meta: Record<string, unknown>): ChannelMessage => ({
  id,
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'KK',
  content,
  replyToId: null,
  meta: JSON.stringify(meta),
  createdAt: new Date().toISOString(),
});

const renderCard = (message: ChannelMessage, onAction: ReturnType<typeof vi.fn>, metaOverride?: Record<string, unknown>) =>
  render(<ReviewProposalCard message={message} meta={metaOverride ?? JSON.parse(message.meta!)} onAction={onAction} />);

// ---------- distill_proposal（原 DistillProposalCard 8 用例） ----------

const distillMessage = msg('msg-dp-1', '知识蒸馏提案 — 待确认', {
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
});

describe('ReviewProposalCard — distill_proposal（原 DistillProposalCard）', () => {
  beforeEach(() => {
    mockProposalStatus.mockReset();
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'pending' } } });
  });

  it('renders 原料清单/命中信号 + 确认蒸馏/拒绝按钮', () => {
    renderCard(distillMessage, vi.fn());
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
    renderCard(distillMessage, onAction);
    fireEvent.click(screen.getByText('确认蒸馏'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-dp-1', 'distill_proposal_approve'));
    expect(await screen.findByText(/已确认，蒸馏已执行/)).toBeTruthy();
  });

  it('锁存（#288 核查）：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    renderCard(distillMessage, onAction);
    const approveBtn = screen.getByText('确认蒸馏').closest('button')!;
    fireEvent.click(approveBtn);
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText('拒绝').closest('button')!.disabled).toBe(true);
    fireEvent.click(approveBtn);
    fireEvent.click(screen.getByText('拒绝'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText(/已确认，蒸馏已执行/)).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('点拒绝 → onAction(messageId, distill_proposal_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(distillMessage, onAction);
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-dp-1', 'distill_proposal_reject'));
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });

  it('onAction 返回 false（如预算熔断）→ 不显示已审态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    renderCard(distillMessage, onAction);
    fireEvent.click(screen.getByText('确认蒸馏'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认蒸馏')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('刷新后按提案状态派生已审态：executed → 已执行（无按钮）', async () => {
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'executed' } } });
    renderCard(distillMessage, vi.fn());
    expect(await screen.findByText(/已确认，蒸馏已执行/)).toBeTruthy();
    expect(screen.queryByText('拒绝')).not.toBeTruthy();
    expect(mockProposalStatus).toHaveBeenCalledWith(['dp-1']);
  });

  it('刷新后按提案状态派生已审态：rejected → 已拒绝；failed → 执行失败', async () => {
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'rejected' } } });
    const { unmount } = renderCard(distillMessage, vi.fn());
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
    unmount();

    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'failed' } } });
    renderCard(distillMessage, vi.fn());
    expect(await screen.findByText(/执行失败/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockProposalStatus.mockRejectedValue(new Error('network'));
    renderCard(distillMessage, vi.fn());
    await waitFor(() => expect(mockProposalStatus).toHaveBeenCalled());
    expect(screen.getByText('确认蒸馏')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});

// ---------- gc_proposal（原 GcProposalCard 9 用例） ----------

const gcMessage = msg('msg-gc-1', '知识库 GC 候选清单 — 待确认', {
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
});

describe('ReviewProposalCard — gc_proposal（原 GcProposalCard）', () => {
  beforeEach(() => {
    mockGcProposalStatus.mockReset();
    mockGcProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'gc-1': 'pending' } } });
  });

  it('renders 候选清单（逐条理由）+ 确认归档/全部保留按钮', () => {
    renderCard(gcMessage, vi.fn());
    expect(screen.getByText('过时的部署笔记')).toBeTruthy();
    expect(screen.getByText('旧的鉴权约定')).toBeTruthy();
    expect(screen.getAllByText(/连续 3 个蒸馏周期零引用/).length).toBeGreaterThan(0);
    expect(screen.getByText(/连续 4 个蒸馏周期零引用/)).toBeTruthy();
    expect(screen.getByText('2 条候选')).toBeTruthy();
    expect(screen.getByText('确认归档')).toBeTruthy();
    expect(screen.getByText('全部保留')).toBeTruthy();
  });

  it('forced=true 时显示超容量强制说明', () => {
    const meta = JSON.parse(gcMessage.meta!);
    meta.cardData.forced = true;
    meta.cardData.mainAreaCount = 203;
    renderCard(gcMessage, vi.fn(), meta);
    expect(screen.getByText(/203 条已超容量上限/)).toBeTruthy();
  });

  it('锁存（#288 核查）：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    renderCard(gcMessage, onAction);
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
    renderCard(gcMessage, onAction);
    fireEvent.click(screen.getByText('确认归档'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-gc-1', 'gc_proposal_approve'));
    expect(await screen.findByText(/已确认，候选条目已归档/)).toBeTruthy();
  });

  it('点全部保留 → onAction(messageId, gc_proposal_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(gcMessage, onAction);
    fireEvent.click(screen.getByText('全部保留'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-gc-1', 'gc_proposal_reject'));
    expect(await screen.findByText(/已拒绝，条目全部保留/)).toBeTruthy();
  });

  it('onAction 返回 false → 不显示已审态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    renderCard(gcMessage, onAction);
    fireEvent.click(screen.getByText('确认归档'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认归档')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('刷新后按提案状态派生已审态：executed → 已归档（无按钮）', async () => {
    mockGcProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'gc-1': 'executed' } } });
    renderCard(gcMessage, vi.fn());
    expect(await screen.findByText(/已确认，候选条目已归档/)).toBeTruthy();
    expect(screen.queryByText('全部保留')).not.toBeTruthy();
    expect(mockGcProposalStatus).toHaveBeenCalledWith(['gc-1']);
  });

  it('刷新后按提案状态派生已审态：rejected → 已拒绝', async () => {
    mockGcProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'gc-1': 'rejected' } } });
    renderCard(gcMessage, vi.fn());
    expect(await screen.findByText(/已拒绝，条目全部保留/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockGcProposalStatus.mockRejectedValue(new Error('network'));
    renderCard(gcMessage, vi.fn());
    await waitFor(() => expect(mockGcProposalStatus).toHaveBeenCalled());
    expect(screen.getByText('确认归档')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});

// ---------- memory_proposal（原 MemoryProposalCard 9 用例） ----------

const memoryMessage = msg('msg-mp-1', '角色记忆提案 — 待确认', {
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
});

describe('ReviewProposalCard — memory_proposal（原 MemoryProposalCard）', () => {
  beforeEach(() => {
    mockDraftStatus.mockReset();
    mockDraftStatus.mockResolvedValue({ data: { success: true, statuses: { 'd-1': 'pending', 'd-2': 'pending' } } });
  });

  it('renders 标题/文件路径/人类可读标签 + 确认写入/丢弃按钮，无内部分类词', () => {
    renderCard(memoryMessage, vi.fn());
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

  it('锁存（#288 核查）：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    renderCard(memoryMessage, onAction);
    const approveBtn = screen.getByText('确认写入').closest('button')!;
    fireEvent.click(approveBtn);
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText('丢弃').closest('button')!.disabled).toBe(true);
    fireEvent.click(approveBtn);
    fireEvent.click(screen.getByText('丢弃'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText(/已确认，已写入记忆/)).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('点确认写入 → onAction(messageId, memory_proposal_approve)，成功后显示已确认', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(memoryMessage, onAction);
    fireEvent.click(screen.getByText('确认写入'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-mp-1', 'memory_proposal_approve'));
    expect(await screen.findByText(/已确认/)).toBeTruthy();
  });

  it('点丢弃 → onAction(messageId, memory_proposal_reject)，成功后显示已丢弃', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(memoryMessage, onAction);
    fireEvent.click(screen.getByText('丢弃'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-mp-1', 'memory_proposal_reject'));
    expect(await screen.findByText(/已丢弃/)).toBeTruthy();
  });

  it('onAction 返回 false → 不显示已审核状态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    renderCard(memoryMessage, onAction);
    fireEvent.click(screen.getByText('确认写入'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认写入')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('meta.status 已为 approved → 直接渲染已确认（无按钮）', () => {
    const meta = { ...JSON.parse(memoryMessage.meta!), status: 'approved' };
    renderCard(memoryMessage, vi.fn(), meta);
    expect(screen.getByText(/已确认/)).toBeTruthy();
    expect(screen.queryByText('丢弃')).not.toBeTruthy();
  });

  it('刷新后按草稿状态派生已审态：全部 promoted → 已确认（无按钮）', async () => {
    mockDraftStatus.mockResolvedValue({ data: { success: true, statuses: { 'd-1': 'promoted', 'd-2': 'promoted' } } });
    renderCard(memoryMessage, vi.fn());
    expect(await screen.findByText(/已确认/)).toBeTruthy();
    expect(screen.queryByText('丢弃')).not.toBeTruthy();
    expect(mockDraftStatus).toHaveBeenCalledWith('role-1', ['d-1', 'd-2']);
  });

  it('刷新后按草稿状态派生已审态：全部 rejected → 已丢弃', async () => {
    mockDraftStatus.mockResolvedValue({ data: { success: true, statuses: { 'd-1': 'rejected', 'd-2': 'rejected' } } });
    renderCard(memoryMessage, vi.fn());
    expect(await screen.findByText(/已丢弃/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockDraftStatus.mockRejectedValue(new Error('network'));
    renderCard(memoryMessage, vi.fn());
    await waitFor(() => expect(mockDraftStatus).toHaveBeenCalled());
    expect(screen.getByText('确认写入')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});

// ---------- knowledge_proposal（原 KnowledgeProposalCard 8 用例） ----------

const knowledgeMessage = msg('msg-kp-1', '知识提案 — 待人工审核', {
  cardType: 'knowledge_proposal',
  status: 'ready',
  cardData: {
    workUnitId: 'WU-2042',
    entries: [
      { id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' },
      { id: 'k-2', title: '登录流程统一走 auth-service', type: 'guideline' },
    ],
  },
});

describe('ReviewProposalCard — knowledge_proposal（原 KnowledgeProposalCard）', () => {
  beforeEach(() => {
    mockGetEntry.mockReset();
    mockGetEntry.mockResolvedValue({ data: { maturity: 'draft' } });
  });

  it('renders 条目标题/类型 + 通过/拒绝按钮', () => {
    renderCard(knowledgeMessage, vi.fn());
    expect(screen.getByText('session 过期未刷新导致 401')).toBeTruthy();
    expect(screen.getByText('登录流程统一走 auth-service')).toBeTruthy();
    expect(screen.getByText('2 条知识')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText(/WU-2042/)).toBeTruthy();
  });

  it('点通过 → onAction(messageId, knowledge_proposal_approve)，成功后显示已审核状态', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(knowledgeMessage, onAction);
    fireEvent.click(screen.getByText('通过'));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('msg-kp-1', 'knowledge_proposal_approve');
    });
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(screen.queryByText('通过')).not.toBeTruthy();
  });

  it('锁存（#288 核查）：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    renderCard(knowledgeMessage, onAction);
    const approveBtn = screen.getByText('通过').closest('button')!;
    fireEvent.click(approveBtn);
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText('拒绝').closest('button')!.disabled).toBe(true);
    fireEvent.click(approveBtn);
    fireEvent.click(screen.getByText('拒绝'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('点拒绝 → onAction(messageId, knowledge_proposal_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(knowledgeMessage, onAction);
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('msg-kp-1', 'knowledge_proposal_reject');
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });

  it('onAction 返回 false（API 失败）→ 不显示已审核状态，按钮仍在', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    renderCard(knowledgeMessage, onAction);
    fireEvent.click(screen.getByText('通过'));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('通过')).toBeTruthy());
    expect(screen.queryByText(/已通过/)).not.toBeTruthy();
  });

  it('meta.status 已为 approved → 直接渲染已审核状态（无按钮）', () => {
    const meta = { ...JSON.parse(knowledgeMessage.meta!), status: 'approved' };
    renderCard(knowledgeMessage, vi.fn(), meta);
    expect(screen.getByText(/已通过/)).toBeTruthy();
    expect(screen.queryByText('拒绝')).not.toBeTruthy();
  });

  it('maturity 派生：条目全部 verified → 刷新后也显示已通过', async () => {
    mockGetEntry.mockResolvedValue({ data: { maturity: 'verified' } });
    renderCard(knowledgeMessage, vi.fn());
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(screen.queryByText('拒绝')).not.toBeTruthy();
  });

  it('maturity 派生：条目全部 archived → 显示已拒绝；混合状态保持待审', async () => {
    mockGetEntry.mockResolvedValue({ data: { maturity: 'archived' } });
    const { unmount } = renderCard(knowledgeMessage, vi.fn());
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
    unmount();

    mockGetEntry
      .mockResolvedValueOnce({ data: { maturity: 'draft' } })
      .mockResolvedValueOnce({ data: { maturity: 'verified' } });
    renderCard(knowledgeMessage, vi.fn());
    await waitFor(() => expect(mockGetEntry).toHaveBeenCalledTimes(4));
    expect(screen.getByText('通过')).toBeTruthy();
  });
});

// ---------- constraint_audit_proposal（原 ConstraintAuditCard 9 用例，含 #288 两步确认） ----------

const auditMessage = msg('msg-audit-1', '存量约束退役建议 — 待确认', {
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
});

describe('ReviewProposalCard — constraint_audit_proposal（原 ConstraintAuditCard）', () => {
  beforeEach(() => {
    mockAuditProposalStatus.mockReset();
    mockAuditProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'audit-1': 'pending' } } });
  });

  it('renders 建议清单（逐条判据+理由）+ 确认退役/全部保留按钮', () => {
    renderCard(auditMessage, vi.fn());
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
    renderCard(auditMessage, onAction);
    fireEvent.click(screen.getByText('确认退役'));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/再次点击确认退役/));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-audit-1', 'constraint_audit_approve'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已确认，建议约束已退役/)).toBeTruthy();
  });

  it('待确认态点全部保留 → 退出待确认态并单击直达 constraint_audit_reject', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    renderCard(auditMessage, onAction);
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
    renderCard(auditMessage, onAction);
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
    renderCard(auditMessage, onAction);
    fireEvent.click(screen.getByText('全部保留'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-audit-1', 'constraint_audit_reject'));
    expect(await screen.findByText(/已拒绝，约束全部保留/)).toBeTruthy();
  });

  it('onAction 返回 false → 不显示已审态，退出待确认态且按钮仍可点（失败重武装）', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    renderCard(auditMessage, onAction);
    fireEvent.click(screen.getByText('确认退役'));
    fireEvent.click(screen.getByText(/再次点击确认退役/));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('确认退役').closest('button')!.disabled).toBe(false));
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('刷新后按提案状态派生已审态：executed → 已退役（无按钮）', async () => {
    mockAuditProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'audit-1': 'executed' } } });
    renderCard(auditMessage, vi.fn());
    expect(await screen.findByText(/已确认，建议约束已退役/)).toBeTruthy();
    expect(screen.queryByText('全部保留')).not.toBeTruthy();
    expect(mockAuditProposalStatus).toHaveBeenCalledWith(['audit-1']);
  });

  it('刷新后按提案状态派生已审态：rejected → 已拒绝', async () => {
    mockAuditProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'audit-1': 'rejected' } } });
    renderCard(auditMessage, vi.fn());
    expect(await screen.findByText(/已拒绝，约束全部保留/)).toBeTruthy();
  });

  it('派生接口失败 → 静默保持待审（按钮仍在）', async () => {
    mockAuditProposalStatus.mockRejectedValue(new Error('network'));
    renderCard(auditMessage, vi.fn());
    await waitFor(() => expect(mockAuditProposalStatus).toHaveBeenCalled());
    expect(screen.getByText('确认退役')).toBeTruthy();
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });
});
