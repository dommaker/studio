// knowledge 域提案卡配置（拆分来源：components/channel/proposalCardConfigs.tsx）
// 2026-07 知识审核闭环（#355 已切通用端点 /review-proposals/knowledge/:proposalId/*，整卡一次审批）
import { knowledgeApi } from '../../../api/knowledge';
import { proposalExec, entryRowCls, metaStatusReviewed, type ProposalCardConfig } from './shared';

interface KnowledgeEntry {
  id: string;
  title: string;
  type: string;
}

/** knowledge 卡 type → 人类可读标签（#473 导出：监控页知识提案展开详情同词表复用） */
export const KNOWLEDGE_TYPE_LABELS: Record<string, string> = {
  decision: '设计决策',
  pitfall: '踩坑记录',
  guideline: '最佳实践',
  model: '架构模式',
  process: '流程',
  architecture: '架构',
};

export const knowledgeProposalConfig: ProposalCardConfig = {
  cardType: 'knowledge_proposal',
  kind: 'knowledge',
  approveAction: 'knowledge_proposal_approve',
  rejectAction: 'knowledge_proposal_reject',
  approvedState: 'approved',
  exec: proposalExec('proposalId', knowledgeApi.approveProposal, knowledgeApi.rejectProposal),
  // 已审核态按提案状态派生（正本词表 → 卡终态词）：executed→approved，rejected→rejected，
  // failed→failed；pending/card-failed/unknown → 保持待审
  fetchReviewed: async cardData => {
    const proposalId = typeof cardData?.proposalId === 'string' ? (cardData.proposalId as string) : '';
    if (!proposalId) return null;
    const { data } = await knowledgeApi.proposalStatus(proposalId);
    // 契约驱动迁移（批次 4/7）：status 响应 `{ data: { status } }`（success 标志退役）
    if (data?.data?.status === 'executed') return 'approved';
    if (data?.data?.status === 'rejected') return 'rejected';
    if (data?.data?.status === 'failed') return 'failed';
    return null;
  },
  initialReviewed: metaStatusReviewed,
  reviewedTitle: '知识提案',
  reviewLabels: {
    approved: { text: '已通过，参与注入', cls: 'mc-status-done' },
    rejected: { text: '已拒绝，已归档', cls: 'mc-status-error' },
    failed: { text: '审批执行失败（条目未生效）', cls: 'mc-status-error' },
  },
  pendingTitle: '知识提案 — 待审核',
  countText: cd => `${(cd?.entries as unknown[] | undefined)?.length || 0} 条知识`,
  approveLabel: '通过',
  rejectLabel: '拒绝',
  renderContent: cd => {
    const entries = cd?.entries as KnowledgeEntry[] | undefined;
    const workUnitId = cd?.workUnitId as string | null | undefined;
    return (
      <>
        {entries?.map(e => (
          <div key={e.id} className={entryRowCls}>
            <span className="mc-card-body font-semibold">{e.title}</span>
            <span className="mc-status mc-status-pending ml-1.5">{KNOWLEDGE_TYPE_LABELS[e.type] || e.type}</span>
          </div>
        ))}
        {workUnitId && (
          <div className="mc-time mb-1.5">来源 WorkUnit: {workUnitId}</div>
        )}
      </>
    );
  },
};
