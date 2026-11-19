// distill 域提案卡配置（拆分来源：components/channel/proposalCardConfigs.tsx）
// #143 蒸馏提案 + #144 知识库 GC 候选清单（同走 distillApi 家族端点）
import { distillApi } from '../../../api/distill';
import { proposalExec, proposalFetchReviewed, entryRowCls, type ProposalCardConfig } from './shared';

// #143 蒸馏提案
export const distillProposalConfig: ProposalCardConfig = {
  cardType: 'distill_proposal',
  kind: 'distill',
  approveAction: 'distill_proposal_approve',
  rejectAction: 'distill_proposal_reject',
  approvedState: 'executed',
  exec: proposalExec('proposalId', distillApi.approve, distillApi.reject),
  fetchReviewed: proposalFetchReviewed('proposalId', distillApi.proposalStatus, ['executed', 'rejected', 'failed']),
  reviewedTitle: '知识提炼',
  reviewLabels: {
    executed: { text: '已确认，提炼已执行', cls: 'mc-status-done' },
    rejected: { text: '已拒绝，本轮零副作用', cls: 'mc-status-error' },
    failed: { text: '提炼执行失败（工单未消费）', cls: 'mc-status-error' },
  },
  pendingTitle: '知识提炼提案 — 待确认',
  countText: cd => `已完成工单 ${(cd?.materials as unknown[] | undefined)?.length || 0} 条`,
  approveLabel: '确认提炼',
  rejectLabel: '拒绝',
  renderContent: cd => {
    const materials = cd?.materials as Array<{ id: string; title: string }> | undefined;
    const signals = cd?.signals as { topicTags?: string[]; manualCount?: number } | undefined;
    const signalParts: string[] = [];
    if (signals?.topicTags?.length) signalParts.push(`同 topic/tag 新条目 ≥3（${signals.topicTags.join('、')}）`);
    if (signals?.manualCount) signalParts.push(`manual 过审新条目 ${signals.manualCount} 条`);
    return (
      <>
        {signalParts.length > 0 && (
          <div className="mc-time mb-1.5">命中信号：{signalParts.join('；')}</div>
        )}
        {materials?.map(m => (
          <div key={m.id} className={entryRowCls}>
            <span className="mc-card-body font-semibold">{m.title}</span>
          </div>
        ))}
        <div className="mc-time mb-1.5">
          预期产出：1–5 条提炼后的知识条目；确认后这些工单归档移出主区，拒绝则零副作用。
        </div>
      </>
    );
  },
};

// #144 知识库 GC 候选清单
export const gcProposalConfig: ProposalCardConfig = {
  cardType: 'gc_proposal',
  kind: 'gc',
  approveAction: 'gc_proposal_approve',
  rejectAction: 'gc_proposal_reject',
  approvedState: 'executed',
  exec: proposalExec('gcProposalId', distillApi.gcApprove, distillApi.gcReject),
  fetchReviewed: proposalFetchReviewed('gcProposalId', distillApi.gcProposalStatus, ['executed', 'rejected']),
  reviewedTitle: '知识库 GC',
  reviewLabels: {
    executed: { text: '已确认，候选条目已归档', cls: 'mc-status-done' },
    rejected: { text: '已拒绝，条目全部保留', cls: 'mc-status-error' },
  },
  pendingTitle: '知识库 GC 候选清单 — 待确认',
  countText: cd => `${(cd?.candidates as unknown[] | undefined)?.length || 0} 条候选`,
  approveLabel: '确认归档',
  rejectLabel: '全部保留',
  renderContent: cd => {
    const candidates = cd?.candidates as Array<{ entryId: string; title: string; reason: string }> | undefined;
    const forced = cd?.forced as boolean | undefined;
    const mainAreaCount = cd?.mainAreaCount as number | undefined;
    return (
      <>
        <div className="mc-time mb-1.5">
          {forced
            ? `主区 ${mainAreaCount ?? '—'} 条已超容量上限（200），强制出清单。`
            : '按蒸馏周期计龄：连续 3 个蒸馏周期零引用进候选。'}
        </div>
        {candidates?.map(c => (
          <div key={c.entryId} className={entryRowCls}>
            <span className="mc-card-body font-semibold">{c.title}</span>
            <div className="mc-time">{c.reason}</div>
          </div>
        ))}
        <div className="mc-time mb-1.5">
          确认后候选条目归档移出主区（可恢复）；拒绝则全部保留且后续不再提案。
        </div>
      </>
    );
  },
};
