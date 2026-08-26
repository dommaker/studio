// proposalCardConfigs（#352）配置完整性 + exec/fetchReviewed 行为测试。
// 渲染面行为由 ReviewProposalCard.test.tsx 覆盖；本文件锁配置正本自身的契约。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROPOSAL_CARD_CONFIGS, PROPOSAL_ACTION_INDEX } from '../proposalCardConfigs';
import { distillApi } from '../../../api/distill';
import { memoryApi } from '../../../api/memory';
import { knowledgeApi } from '../../../api/knowledge';

vi.mock('../../../api/distill', () => ({
  distillApi: {
    approve: vi.fn(),
    reject: vi.fn(),
    proposalStatus: vi.fn(),
    gcApprove: vi.fn(),
    gcReject: vi.fn(),
    gcProposalStatus: vi.fn(),
    auditApprove: vi.fn(),
    auditReject: vi.fn(),
    auditProposalStatus: vi.fn(),
  },
}));
vi.mock('../../../api/memory', () => ({
  memoryApi: { promote: vi.fn(), demote: vi.fn(), draftStatus: vi.fn() },
}));
vi.mock('../../../api/knowledge', () => ({
  knowledgeApi: { promote: vi.fn(), demote: vi.fn(), getEntry: vi.fn() },
}));

const CARD_TYPES = [
  'distill_proposal',
  'gc_proposal',
  'memory_proposal',
  'knowledge_proposal',
  'constraint_audit_proposal',
];

beforeEach(() => vi.clearAllMocks());

describe('PROPOSAL_CARD_CONFIGS 完整性', () => {
  it('恰好覆盖 5 类提案卡', () => {
    expect(Object.keys(PROPOSAL_CARD_CONFIGS).sort()).toEqual([...CARD_TYPES].sort());
  });

  it.each(CARD_TYPES)('%s：必备字段齐全且终态词表含 approvedState 与 rejected', cardType => {
    const c = PROPOSAL_CARD_CONFIGS[cardType];
    expect(c.cardType).toBe(cardType);
    expect(c.kind).toBeTruthy();
    expect(c.approveAction).toMatch(/_approve$/);
    expect(c.rejectAction).toMatch(/_reject$/);
    expect(c.reviewLabels[c.approvedState]).toBeDefined();
    expect(c.reviewLabels.rejected).toBeDefined();
    expect(c.reviewedTitle && c.pendingTitle && c.approveLabel && c.rejectLabel).toBeTruthy();
    expect(typeof c.countText).toBe('function');
    expect(typeof c.renderContent).toBe('function');
  });

  it('distill 家族 kind 对齐 #351 注册表（distill/gc/audit）；memory/knowledge 待 #353/#355', () => {
    expect(PROPOSAL_CARD_CONFIGS.distill_proposal.kind).toBe('distill');
    expect(PROPOSAL_CARD_CONFIGS.gc_proposal.kind).toBe('gc');
    expect(PROPOSAL_CARD_CONFIGS.constraint_audit_proposal.kind).toBe('audit');
    expect(PROPOSAL_CARD_CONFIGS.memory_proposal.kind).toBe('memory');
    expect(PROPOSAL_CARD_CONFIGS.knowledge_proposal.kind).toBe('knowledge');
  });
});

describe('PROPOSAL_ACTION_INDEX', () => {
  it('10 个 action 全部映射到配置与决策方向', () => {
    expect(Object.keys(PROPOSAL_ACTION_INDEX)).toHaveLength(10);
    for (const c of Object.values(PROPOSAL_CARD_CONFIGS)) {
      expect(PROPOSAL_ACTION_INDEX[c.approveAction]).toEqual({ config: c, decision: 'approve' });
      expect(PROPOSAL_ACTION_INDEX[c.rejectAction]).toEqual({ config: c, decision: 'reject' });
    }
  });
});

describe('distill 家族 exec（通用端点参数化）', () => {
  it('approve success=true → true；success=false（预算熔断/失败）→ false 保持待审', async () => {
    vi.mocked(distillApi.approve).mockResolvedValue({ data: { success: true } } as never);
    await expect(
      PROPOSAL_CARD_CONFIGS.distill_proposal.exec({ proposalId: 'p1' }, 'approve'),
    ).resolves.toBe(true);
    expect(distillApi.approve).toHaveBeenCalledWith('p1');

    vi.mocked(distillApi.approve).mockResolvedValue({ data: { success: false } } as never);
    await expect(
      PROPOSAL_CARD_CONFIGS.distill_proposal.exec({ proposalId: 'p1' }, 'approve'),
    ).resolves.toBe(false);
  });

  it('缺提案 id → false（不调 API）', async () => {
    await expect(PROPOSAL_CARD_CONFIGS.gc_proposal.exec({}, 'approve')).resolves.toBe(false);
    expect(distillApi.gcApprove).not.toHaveBeenCalled();
  });

  it('reject → 调 reject 端点并返回 true', async () => {
    vi.mocked(distillApi.auditReject).mockResolvedValue({} as never);
    await expect(
      PROPOSAL_CARD_CONFIGS.constraint_audit_proposal.exec({ auditProposalId: 'a1' }, 'reject'),
    ).resolves.toBe(true);
    expect(distillApi.auditReject).toHaveBeenCalledWith('a1');
  });
});

describe('distill 家族 fetchReviewed（statuses?.[id] 派生）', () => {
  it('终态词命中 → reviewed；pending/未命中 → null 保持待审', async () => {
    vi.mocked(distillApi.proposalStatus).mockResolvedValue({ data: { statuses: { p1: 'executed' } } } as never);
    await expect(
      PROPOSAL_CARD_CONFIGS.distill_proposal.fetchReviewed!({ proposalId: 'p1' }),
    ).resolves.toBe('executed');

    vi.mocked(distillApi.proposalStatus).mockResolvedValue({ data: { statuses: { p1: 'pending' } } } as never);
    await expect(
      PROPOSAL_CARD_CONFIGS.distill_proposal.fetchReviewed!({ proposalId: 'p1' }),
    ).resolves.toBeNull();
  });
});

describe('memory/knowledge exec 与派生（域端点，#353/#355 前）', () => {
  it('memory：缺 roleId 或空 entries → false；approve → promote(roleId, draftIds)', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.memory_proposal;
    await expect(cfg.exec({ entries: [{ draftId: 'd1' }] }, 'approve')).resolves.toBe(false);
    await expect(cfg.exec({ roleId: 'r1', entries: [] }, 'approve')).resolves.toBe(false);
    vi.mocked(memoryApi.promote).mockResolvedValue({} as never);
    await expect(
      cfg.exec({ roleId: 'r1', entries: [{ draftId: 'd1' }, { draftId: 'd2' }] }, 'approve'),
    ).resolves.toBe(true);
    expect(memoryApi.promote).toHaveBeenCalledWith('r1', ['d1', 'd2']);
  });

  it('memory 派生：全部 promoted → approved；全部 rejected → rejected；混合 → null', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.memory_proposal;
    const cd = { roleId: 'r1', entries: [{ draftId: 'd1' }, { draftId: 'd2' }] };
    vi.mocked(memoryApi.draftStatus).mockResolvedValue({ data: { statuses: { d1: 'promoted', d2: 'promoted' } } } as never);
    await expect(cfg.fetchReviewed!(cd)).resolves.toBe('approved');
    vi.mocked(memoryApi.draftStatus).mockResolvedValue({ data: { statuses: { d1: 'rejected', d2: 'rejected' } } } as never);
    await expect(cfg.fetchReviewed!(cd)).resolves.toBe('rejected');
    vi.mocked(memoryApi.draftStatus).mockResolvedValue({ data: { statuses: { d1: 'promoted', d2: 'draft' } } } as never);
    await expect(cfg.fetchReviewed!(cd)).resolves.toBeNull();
  });

  it('knowledge：approve → 逐条 promote；派生按 maturity（全非 draft/archived → approved，全 archived → rejected）', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.knowledge_proposal;
    vi.mocked(knowledgeApi.promote).mockResolvedValue({} as never);
    await expect(cfg.exec({ entries: [{ id: 'e1' }, { id: 'e2' }] }, 'approve')).resolves.toBe(true);
    expect(knowledgeApi.promote).toHaveBeenCalledTimes(2);

    vi.mocked(knowledgeApi.getEntry)
      .mockResolvedValueOnce({ data: { maturity: 'verified' } } as never)
      .mockResolvedValueOnce({ data: { maturity: 'verified' } } as never);
    await expect(cfg.fetchReviewed!({ entries: [{ id: 'e1' }, { id: 'e2' }] })).resolves.toBe('approved');

    vi.mocked(knowledgeApi.getEntry)
      .mockResolvedValueOnce({ data: { maturity: 'archived' } } as never)
      .mockResolvedValueOnce({ data: { maturity: 'archived' } } as never);
    await expect(cfg.fetchReviewed!({ entries: [{ id: 'e1' }, { id: 'e2' }] })).resolves.toBe('rejected');
  });

  it('meta.status 直读：approved/rejected 直渲，其余 null', () => {
    const ir = PROPOSAL_CARD_CONFIGS.memory_proposal.initialReviewed!;
    expect(ir('approved')).toBe('approved');
    expect(ir('rejected')).toBe('rejected');
    expect(ir('pending')).toBeNull();
  });
});
