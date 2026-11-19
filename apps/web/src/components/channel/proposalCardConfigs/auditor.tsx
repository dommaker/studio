// auditor 域提案卡配置（拆分来源：components/channel/proposalCardConfigs.tsx）
// B3-005 审计建议（#356 已切通用端点 /review-proposals/auditor/:proposalId/*，采纳建未指派 task 工单）
import { auditorApi } from '../../../api/auditor';
import { proposalExec, entryRowCls, type ProposalCardConfig } from './shared';

/** auditor 存量卡 meta.status 直读（#356 前旧卡终态词 confirmed/rejected，读侧归一为 approved/rejected） */
const auditorMetaStatusReviewed: ProposalCardConfig['initialReviewed'] = s =>
  s === 'confirmed' ? 'approved' : s === 'rejected' ? 'rejected' : null;

/** auditor 卡 type → 人类可读标签（自旧 AuditorSuggestionCard TYPE_LABELS 原样搬入） */
const AUDITOR_TYPE_LABELS: Record<string, string> = {
  param_tuning: '参数调优',
  prompt_optimization: 'Prompt 优化',
  skill_weight: 'Skill 权重',
  skill_status: 'Skill 发布',
};

export const auditorSuggestionConfig: ProposalCardConfig = {
  cardType: 'auditor_suggestion',
  kind: 'auditor',
  approveAction: 'auditor_suggestion_approve',
  rejectAction: 'auditor_suggestion_reject',
  approvedState: 'approved',
  exec: proposalExec('proposalId', auditorApi.approveProposal, auditorApi.rejectProposal),
  // 已审核态按提案状态派生（正本词表 → 卡终态词）：executed→approved，rejected→rejected，
  // failed→failed；pending/card-failed/unknown → 保持待审
  fetchReviewed: async cardData => {
    const proposalId = typeof cardData?.proposalId === 'string' ? (cardData.proposalId as string) : '';
    if (!proposalId) return null;
    const { data } = await auditorApi.proposalStatus(proposalId);
    if (data?.data?.status === 'executed') return 'approved';
    if (data?.data?.status === 'rejected') return 'rejected';
    if (data?.data?.status === 'failed') return 'failed';
    return null;
  },
  initialReviewed: auditorMetaStatusReviewed,
  reviewedTitle: '审计建议',
  reviewLabels: {
    approved: { text: '已确认执行', cls: 'mc-status-done' },
    rejected: { text: '已拒绝', cls: 'mc-status-error' },
    failed: { text: '审批执行失败（工单未创建）', cls: 'mc-status-error' },
  },
  pendingTitle: '审计建议 — 待确认',
  countText: cd => `${(cd?.suggestions as unknown[] | undefined)?.length || 0} 条建议`,
  approveLabel: '确认执行',
  rejectLabel: '拒绝',
  renderContent: cd => {
    const suggestions = cd?.suggestions as Array<{
      type: string; risk: string; agentType?: string; detail: string;
    }> | undefined;
    return (
      <>
        {suggestions?.map((s, i) => (
          <div key={i} className={entryRowCls}>
            <div className="flex items-center gap-1.5">
              <span className="mc-card-body font-semibold">
                {AUDITOR_TYPE_LABELS[s.type] || s.type}
              </span>
              {s.risk === 'high' && (
                <span className="mc-status mc-status-error">高风险</span>
              )}
            </div>
            <p className="mc-card-dim mt-0.5">{s.detail}</p>
            {s.agentType && (
              <span className="mc-time">Agent: {s.agentType}</span>
            )}
          </div>
        ))}
      </>
    );
  },
};
