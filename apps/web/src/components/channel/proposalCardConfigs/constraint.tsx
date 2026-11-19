// constraint 域提案卡配置（拆分来源：components/channel/proposalCardConfigs.tsx）
// ADR-0033 块 3 子项 7/8 约束提案（kind='constraint'，通用端点 /review-proposals/constraint/:proposalId/*）
// 统计白话已由 api markdown 卡正文承载，web 保持哑渲染（只列条目清单）
import { constraintApi } from '../../../api/constraint';
import { proposalExec, entryRowCls, type ProposalCardConfig } from './shared';

export const constraintProposalConfig: ProposalCardConfig = {
  cardType: 'constraint_proposal',
  kind: 'constraint',
  approveAction: 'constraint_proposal_approve',
  rejectAction: 'constraint_proposal_reject',
  approvedState: 'approved',
  exec: proposalExec('proposalId', constraintApi.approve, constraintApi.reject),
  // 已审核态按提案状态派生：executed→approved（卡终态词），rejected→rejected，failed→failed
  fetchReviewed: async cardData => {
    const proposalId = typeof cardData?.proposalId === 'string' ? (cardData.proposalId as string) : '';
    if (!proposalId) return null;
    const { data } = await constraintApi.proposalStatus(proposalId);
    if (data?.data?.status === 'executed') return 'approved';
    if (data?.data?.status === 'rejected') return 'rejected';
    if (data?.data?.status === 'failed') return 'failed';
    return null;
  },
  reviewedTitle: '约束提案',
  reviewLabels: {
    approved: { text: '已确认，约束已生效', cls: 'mc-status-done' },
    rejected: { text: '已拒绝，零副作用', cls: 'mc-status-error' },
    failed: { text: '执行失败（约束未生效）', cls: 'mc-status-error' },
  },
  pendingTitle: '约束提案 — 待审核',
  countText: cd => (cd?.action === 'upgrade' ? '升级提案' : '新约束提案'),
  approveLabel: '批准',
  rejectLabel: '拒绝',
  renderContent: cd => {
    const rule = cd?.rule as string | undefined;
    const constraintId = cd?.constraintId as string | undefined;
    const sourceEntry = cd?.sourceEntry as { title?: string } | undefined;
    return (
      <>
        {constraintId && (
          <div className={entryRowCls}>
            <span className="mc-card-body font-semibold">{constraintId}</span>
            {rule && <div className="mc-time">{rule}</div>}
          </div>
        )}
        {sourceEntry?.title && (
          <div className="mc-time mb-1.5">来源知识：{sourceEntry.title}</div>
        )}
      </>
    );
  },
};
