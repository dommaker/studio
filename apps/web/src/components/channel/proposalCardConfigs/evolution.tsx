// evolution 域提案卡配置（拆分来源：components/channel/proposalCardConfigs.tsx）
// #623 evolution 人审提案（断点 3 遗留补丁：api 侧发卡已久，web 配置本票补；通用端点 kind='evolution'）
// 卡正文（当前/提案/理由/证据白话 markdown）由 api 侧 renderEvolutionCard 承载，web 保持哑渲染
import { evolutionApi } from '../../../api/evolution';
import { proposalExec, entryRowCls, type ProposalCardConfig } from './shared';

/** evolution 卡动作词 → 人类可读标签（提案动作集 M3.2 已收敛为 retire/disable；存量历史词表兜底原词） */
const EVOLUTION_ACTION_LABELS: Record<string, string> = {
  retire: '退役约束',
  disable: '停用约束',
  amend: '修改',
  add: '新增',
};

export const evolutionProposalConfig: ProposalCardConfig = {
  cardType: 'evolution_proposal',
  kind: 'evolution',
  approveAction: 'evolution_proposal_approve',
  rejectAction: 'evolution_proposal_reject',
  approvedState: 'approved',
  exec: proposalExec('proposalId', evolutionApi.approve, evolutionApi.reject),
  // 已审核态按提案状态派生（读侧归一后正本词表 → 卡终态词）：
  // executed（=applied）→approved，rejected→rejected，failed→failed；pending/card-failed/unknown → 保持待审
  fetchReviewed: async cardData => {
    const proposalId = typeof cardData?.proposalId === 'string' ? (cardData.proposalId as string) : '';
    if (!proposalId) return null;
    const { data } = await evolutionApi.proposalStatus(proposalId);
    if (data?.data?.status === 'executed') return 'approved';
    if (data?.data?.status === 'rejected') return 'rejected';
    if (data?.data?.status === 'failed') return 'failed';
    return null;
  },
  reviewedTitle: '约束进化',
  reviewLabels: {
    approved: { text: '已批准，约束变更已生效', cls: 'mc-status-done' },
    rejected: { text: '已拒绝，本轮零副作用', cls: 'mc-status-error' },
    failed: { text: '生效执行失败（可重试）', cls: 'mc-status-error' },
  },
  pendingTitle: '约束进化提案 — 待审核',
  countText: cd => {
    const action = cd?.constraintChange as string | undefined;
    return EVOLUTION_ACTION_LABELS[action ?? ''] ?? '约束变更';
  },
  approveLabel: '批准生效',
  rejectLabel: '拒绝',
  renderContent: cd => {
    const targetId = cd?.targetId as string | undefined;
    const targetType = cd?.targetType as string | undefined;
    const action = cd?.constraintChange as string | undefined;
    return (
      <>
        {targetId && (
          <div className={entryRowCls}>
            <span className="mc-card-body font-semibold">{targetId}</span>
            {action && (
              <span className="mc-status mc-status-pending ml-1.5">
                {EVOLUTION_ACTION_LABELS[action] ?? action}
              </span>
            )}
            {targetType && <div className="mc-time">目标类型：{targetType}</div>}
          </div>
        )}
      </>
    );
  },
};
