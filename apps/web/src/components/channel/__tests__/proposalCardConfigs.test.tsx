// proposalCardConfigs（#352）配置完整性 + exec/fetchReviewed 行为测试。
// 渲染面行为由 ReviewProposalCard.test.tsx 覆盖；本文件锁配置正本自身的契约。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROPOSAL_CARD_CONFIGS, PROPOSAL_ACTION_INDEX } from '../proposalCardConfigs';
import { distillApi } from '../../../api/distill';
import { memoryApi } from '../../../api/memory';
import { knowledgeApi } from '../../../api/knowledge';
import { auditorApi } from '../../../api/auditor';

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
  memoryApi: { approve: vi.fn(), reject: vi.fn(), status: vi.fn() },
}));
vi.mock('../../../api/knowledge', () => ({
  knowledgeApi: { approveProposal: vi.fn(), rejectProposal: vi.fn(), proposalStatus: vi.fn() },
}));
vi.mock('../../../api/auditor', () => ({
  auditorApi: { approveProposal: vi.fn(), rejectProposal: vi.fn(), proposalStatus: vi.fn() },
}));

const CARD_TYPES = [
  'distill_proposal',
  'gc_proposal',
  'memory_proposal',
  'knowledge_proposal',
  'constraint_audit_proposal',
  'auditor_suggestion',
];

beforeEach(() => vi.clearAllMocks());

describe('PROPOSAL_CARD_CONFIGS 完整性', () => {
  it('恰好覆盖 6 类提案卡', () => {
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

  it('distill 家族 + memory/knowledge/auditor kind 对齐注册表（distill/gc/audit #351，memory #353，knowledge #355，auditor #356）', () => {
    expect(PROPOSAL_CARD_CONFIGS.distill_proposal.kind).toBe('distill');
    expect(PROPOSAL_CARD_CONFIGS.gc_proposal.kind).toBe('gc');
    expect(PROPOSAL_CARD_CONFIGS.constraint_audit_proposal.kind).toBe('audit');
    expect(PROPOSAL_CARD_CONFIGS.memory_proposal.kind).toBe('memory');
    expect(PROPOSAL_CARD_CONFIGS.knowledge_proposal.kind).toBe('knowledge');
    expect(PROPOSAL_CARD_CONFIGS.auditor_suggestion.kind).toBe('auditor');
  });
});

describe('PROPOSAL_ACTION_INDEX', () => {
  it('12 个 action 全部映射到配置与决策方向', () => {
    expect(Object.keys(PROPOSAL_ACTION_INDEX)).toHaveLength(12);
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

describe('memory（#353）/knowledge（#355）通用端点 exec 与派生', () => {
  it('memory：空 entries → false；approve → 逐 draftId approve，任一 success=false → false 保持待审', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.memory_proposal;
    await expect(cfg.exec({ roleId: 'r1', entries: [] }, 'approve')).resolves.toBe(false);
    vi.mocked(memoryApi.approve).mockResolvedValue({ data: { success: true } } as never);
    await expect(
      cfg.exec({ roleId: 'r1', entries: [{ draftId: 'd1' }, { draftId: 'd2' }] }, 'approve'),
    ).resolves.toBe(true);
    expect(memoryApi.approve).toHaveBeenCalledWith('d1');
    expect(memoryApi.approve).toHaveBeenCalledWith('d2');

    vi.mocked(memoryApi.approve)
      .mockResolvedValueOnce({ data: { success: true } } as never)
      .mockResolvedValueOnce({ data: { success: false } } as never);
    await expect(
      cfg.exec({ roleId: 'r1', entries: [{ draftId: 'd1' }, { draftId: 'd2' }] }, 'approve'),
    ).resolves.toBe(false);
  });

  it('memory：reject → 逐 draftId reject；派生：全部 executed → approved；全部 rejected → rejected；混合 → null', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.memory_proposal;
    const cd = { roleId: 'r1', entries: [{ draftId: 'd1' }, { draftId: 'd2' }] };
    vi.mocked(memoryApi.reject).mockResolvedValue({} as never);
    await expect(cfg.exec(cd, 'reject')).resolves.toBe(true);
    expect(memoryApi.reject).toHaveBeenCalledWith('d1');
    expect(memoryApi.reject).toHaveBeenCalledWith('d2');

    vi.mocked(memoryApi.status).mockResolvedValue({ data: { statuses: { d1: 'executed', d2: 'executed' } } } as never);
    await expect(cfg.fetchReviewed!(cd)).resolves.toBe('approved');
    vi.mocked(memoryApi.status).mockResolvedValue({ data: { statuses: { d1: 'rejected', d2: 'rejected' } } } as never);
    await expect(cfg.fetchReviewed!(cd)).resolves.toBe('rejected');
    vi.mocked(memoryApi.status).mockResolvedValue({ data: { statuses: { d1: 'executed', d2: 'pending' } } } as never);
    await expect(cfg.fetchReviewed!(cd)).resolves.toBeNull();
  });

  it('knowledge（#355 通用端点）：approve → 整卡一次 approveProposal；success=false → false；缺 proposalId → false', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.knowledge_proposal;
    vi.mocked(knowledgeApi.approveProposal).mockResolvedValue({ data: { success: true } } as never);
    await expect(
      cfg.exec({ proposalId: 'kp1', entries: [{ id: 'e1' }, { id: 'e2' }] }, 'approve'),
    ).resolves.toBe(true);
    expect(knowledgeApi.approveProposal).toHaveBeenCalledTimes(1);
    expect(knowledgeApi.approveProposal).toHaveBeenCalledWith('kp1');

    vi.mocked(knowledgeApi.approveProposal).mockResolvedValue({ data: { success: false } } as never);
    await expect(cfg.exec({ proposalId: 'kp1' }, 'approve')).resolves.toBe(false);

    await expect(cfg.exec({ entries: [{ id: 'e1' }] }, 'approve')).resolves.toBe(false);

    vi.mocked(knowledgeApi.rejectProposal).mockResolvedValue({} as never);
    await expect(cfg.exec({ proposalId: 'kp1' }, 'reject')).resolves.toBe(true);
    expect(knowledgeApi.rejectProposal).toHaveBeenCalledWith('kp1');
  });

  it('knowledge：派生按提案状态（executed→approved，rejected→rejected，failed→failed，pending/unknown→null）', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.knowledge_proposal;
    vi.mocked(knowledgeApi.proposalStatus).mockResolvedValue({ data: { status: 'executed' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'kp1' })).resolves.toBe('approved');
    vi.mocked(knowledgeApi.proposalStatus).mockResolvedValue({ data: { status: 'rejected' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'kp1' })).resolves.toBe('rejected');
    vi.mocked(knowledgeApi.proposalStatus).mockResolvedValue({ data: { status: 'failed' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'kp1' })).resolves.toBe('failed');
    vi.mocked(knowledgeApi.proposalStatus).mockResolvedValue({ data: { status: 'pending' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'kp1' })).resolves.toBeNull();
    await expect(cfg.fetchReviewed!({})).resolves.toBeNull();
  });

  it('meta.status 直读：approved/rejected 直渲，其余 null', () => {
    const ir = PROPOSAL_CARD_CONFIGS.memory_proposal.initialReviewed!;
    expect(ir('approved')).toBe('approved');
    expect(ir('rejected')).toBe('rejected');
    expect(ir('pending')).toBeNull();
  });
});

describe('auditor（#356 通用端点）exec 与派生', () => {
  it('approve → 整卡一次 approveProposal；success=false → false；缺 proposalId → false；reject → rejectProposal', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.auditor_suggestion;
    vi.mocked(auditorApi.approveProposal).mockResolvedValue({ data: { success: true } } as never);
    await expect(
      cfg.exec({ proposalId: 'ap1', suggestions: [{ type: 'param_tuning' }] }, 'approve'),
    ).resolves.toBe(true);
    expect(auditorApi.approveProposal).toHaveBeenCalledTimes(1);
    expect(auditorApi.approveProposal).toHaveBeenCalledWith('ap1');

    vi.mocked(auditorApi.approveProposal).mockResolvedValue({ data: { success: false } } as never);
    await expect(cfg.exec({ proposalId: 'ap1' }, 'approve')).resolves.toBe(false);

    await expect(cfg.exec({ suggestions: [] }, 'approve')).resolves.toBe(false);

    vi.mocked(auditorApi.rejectProposal).mockResolvedValue({} as never);
    await expect(cfg.exec({ proposalId: 'ap1' }, 'reject')).resolves.toBe(true);
    expect(auditorApi.rejectProposal).toHaveBeenCalledWith('ap1');
  });

  it('派生按提案状态（executed→approved，rejected→rejected，failed→failed，pending/unknown→null）', async () => {
    const cfg = PROPOSAL_CARD_CONFIGS.auditor_suggestion;
    vi.mocked(auditorApi.proposalStatus).mockResolvedValue({ data: { status: 'executed' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'ap1' })).resolves.toBe('approved');
    vi.mocked(auditorApi.proposalStatus).mockResolvedValue({ data: { status: 'rejected' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'ap1' })).resolves.toBe('rejected');
    vi.mocked(auditorApi.proposalStatus).mockResolvedValue({ data: { status: 'failed' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'ap1' })).resolves.toBe('failed');
    vi.mocked(auditorApi.proposalStatus).mockResolvedValue({ data: { status: 'pending' } } as never);
    await expect(cfg.fetchReviewed!({ proposalId: 'ap1' })).resolves.toBeNull();
    await expect(cfg.fetchReviewed!({})).resolves.toBeNull();
  });

  it('存量卡 meta.status 直读：confirmed→approved / rejected→rejected，其余 null', () => {
    const ir = PROPOSAL_CARD_CONFIGS.auditor_suggestion.initialReviewed!;
    expect(ir('confirmed')).toBe('approved');
    expect(ir('rejected')).toBe('rejected');
    expect(ir('ready')).toBeNull();
  });
});
