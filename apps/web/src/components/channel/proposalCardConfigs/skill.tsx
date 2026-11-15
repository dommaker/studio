// #717 Skill 提案卡：一次人审通过后由 API 完成质量门与发布。
import { skillsApi } from '../../../api/skills';
import { entryRowCls, proposalExec, type ProposalCardConfig } from './shared';

export const skillProposalConfig: ProposalCardConfig = {
  cardType: 'skill_review_request',
  kind: 'skill',
  approveAction: 'skill_review_request_approve',
  rejectAction: 'skill_review_request_reject',
  approvedState: 'approved',
  exec: proposalExec('proposalId', skillsApi.approveProposal, skillsApi.rejectProposal),
  fetchReviewed: async cardData => {
    const proposalId = typeof cardData?.proposalId === 'string' ? cardData.proposalId : '';
    if (!proposalId) return null;
    const { data } = await skillsApi.proposalStatus(proposalId);
    if (data?.data?.status === 'executed') return 'approved';
    if (data?.data?.status === 'rejected') return 'rejected';
    if (data?.data?.status === 'failed') return 'failed';
    return null;
  },
  reviewedTitle: 'Skill 审核',
  reviewLabels: {
    approved: { text: '已通过并发布', cls: 'mc-status-done' },
    rejected: { text: '已拒绝', cls: 'mc-status-error' },
    failed: { text: '发布失败', cls: 'mc-status-error' },
  },
  pendingTitle: 'Skill 审核 — 待确认',
  countText: () => '1 个 Skill',
  approveLabel: '通过并发布',
  rejectLabel: '拒绝',
  renderContent: cardData => {
    const name = typeof cardData?.name === 'string'
      ? cardData.name
      : typeof cardData?.skillId === 'string' ? cardData.skillId : '未命名 Skill';
    const description = typeof cardData?.description === 'string' ? cardData.description : '';
    const sourceGoalIds = Array.isArray(cardData?.sourceGoalIds) ? cardData.sourceGoalIds : [];
    return (
      <div className={entryRowCls}>
        <div className="mc-card-body font-semibold">{name}</div>
        {description && <p className="mc-card-dim mt-0.5">{description}</p>}
        {cardData?.proposedBy === 'distill' && (
          <p className="mc-card-dim mt-0.5">来源：知识蒸馏（原料 {sourceGoalIds.length} 条）</p>
        )}
      </div>
    );
  },
};
