// 人审提案卡配置（#352，ADR 2026-08-25 决策 5）：5 张提案卡坍缩为「条目清单 + 文案」纯数据配置。
// 壳 = ReviewProposalCard；生命周期 = useProposalReview；action 分发 = useChannelCardActions
// 经 PROPOSAL_ACTION_INDEX 参数化调用 config.exec。
// 端点现状：distill/gc/audit 三类经 distillApi 走 #351 通用端点 /review-proposals/:kind/:id/*；
// memory/knowledge 保留现有域端点（memoryApi/knowledgeApi）——#353/#355 后端接线后
// 只需改本文件对应条目的 exec/fetchReviewed 即可切到通用端点（kind 字段已就位）。
import type { ReactNode } from 'react';
import { distillApi } from '../../api/distill';
import { knowledgeApi } from '../../api/knowledge';
import { memoryApi } from '../../api/memory';

/** 卡片已审终态词（distill 家族 = 提案状态 executed/rejected/failed；memory/knowledge = approved/rejected） */
export type ProposalReviewState = 'approved' | 'rejected' | 'executed' | 'failed';

export interface ProposalCardConfig {
  /** 消息 meta.cardType（渲染分发键） */
  cardType: string;
  /** review-proposal 注册表 kind（distill/gc/audit 已接通通用端点；memory/knowledge 待 #353/#355） */
  kind: string;
  approveAction: string;
  rejectAction: string;
  /** approve 成功后落入的已审终态词（reject 恒为 'rejected'） */
  approvedState: ProposalReviewState;
  /** 审批副作用（dispatch 参数化调用）：false = 保持待审且不 refresh；异常由调用方归一为 false */
  exec: (cardData: Record<string, unknown> | null, decision: 'approve' | 'reject') => Promise<boolean>;
  /** 挂载期派生已审态（打开时查一次，不实时推送——ADR 决策 6）：null = 保持待审；抛错由 hook 静默 */
  fetchReviewed?: (cardData: Record<string, unknown> | null) => Promise<ProposalReviewState | null>;
  /** meta.status 直读已审态（memory/knowledge 现有行为） */
  initialReviewed?: (metaStatus: unknown) => ProposalReviewState | null;
  /** 终态墓碑卡头 */
  reviewedTitle: string;
  reviewLabels: Partial<Record<ProposalReviewState, { text: string; cls: string }>>;
  pendingTitle: string;
  countText: (cardData: Record<string, unknown> | undefined) => string;
  approveLabel: string;
  rejectLabel: string;
  /** #288 两步确认（高危操作）：首次点击仅进入待确认态，再次点击才执行 */
  twoStepApprove?: boolean;
  armedApproveLabel?: string;
  /** 条目清单 + 说明文案（卡间唯一真正的 diff） */
  renderContent: (cardData: Record<string, unknown> | undefined) => ReactNode;
}

/** distill 家族审批副作用：按提案 id 走通用端点；approve success=false（预算熔断/执行失败）→ 保持待审 */
function proposalExec(
  idKey: string,
  approve: (id: string) => Promise<{ data: { success?: boolean } }>,
  reject: (id: string) => Promise<unknown>,
): ProposalCardConfig['exec'] {
  return async (cardData, decision) => {
    const id = typeof cardData?.[idKey] === 'string' ? (cardData[idKey] as string) : '';
    if (!id) return false;
    if (decision === 'approve') {
      const { data } = await approve(id);
      if (!data?.success) return false;
    } else {
      await reject(id);
    }
    return true;
  };
}

/** distill 家族已审态派生：statuses?.[id] 命中终态词表 → reviewed，否则保持待审 */
function proposalFetchReviewed(
  idKey: string,
  statusApi: (ids: string[]) => Promise<{ data: { statuses?: Record<string, string> } }>,
  terminalStates: ProposalReviewState[],
): ProposalCardConfig['fetchReviewed'] {
  return async cardData => {
    const id = typeof cardData?.[idKey] === 'string' ? (cardData[idKey] as string) : '';
    if (!id) return null;
    const { data } = await statusApi([id]);
    const status = data?.statuses?.[id];
    return (terminalStates as string[]).includes(status ?? '') ? (status as ProposalReviewState) : null;
  };
}

/** 条目样式行（5 卡共用的清单行骨架：marginBottom + 底部分隔线） */
const entryRowStyle = { marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 } as const;

/** memory 卡 kind → 人类可读标签（不暴露 execution-knowledge / preference 内部分类词） */
const MEMORY_KIND_LABELS: Record<string, string> = {
  'execution-knowledge': '经验做法',
  preference: '偏好约定',
};

/** knowledge 卡 type → 人类可读标签 */
const KNOWLEDGE_TYPE_LABELS: Record<string, string> = {
  decision: '设计决策',
  pitfall: '踩坑记录',
  guideline: '最佳实践',
  model: '架构模式',
  process: '流程',
  architecture: '架构',
};

/** audit 卡 category → 人类可读标签 */
const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  'target-gone': '作用对象已消失',
  'reintroduction-sealed': '再引入路径已封死',
};

/** meta.status 直读（memory/knowledge 共有行为） */
const metaStatusReviewed: ProposalCardConfig['initialReviewed'] = s =>
  s === 'approved' || s === 'rejected' ? s : null;

interface MemoryEntry {
  draftId: string;
  title: string;
  topicPath?: string;
  kind?: string;
}

interface KnowledgeEntry {
  id: string;
  title: string;
  type: string;
}

export const PROPOSAL_CARD_CONFIGS: Record<string, ProposalCardConfig> = {
  // #143 蒸馏提案
  distill_proposal: {
    cardType: 'distill_proposal',
    kind: 'distill',
    approveAction: 'distill_proposal_approve',
    rejectAction: 'distill_proposal_reject',
    approvedState: 'executed',
    exec: proposalExec('proposalId', distillApi.approve, distillApi.reject),
    fetchReviewed: proposalFetchReviewed('proposalId', distillApi.proposalStatus, ['executed', 'rejected', 'failed']),
    reviewedTitle: '知识蒸馏',
    reviewLabels: {
      executed: { text: '已确认，蒸馏已执行', cls: 'mc-status-done' },
      rejected: { text: '已拒绝，本轮零副作用', cls: 'mc-status-error' },
      failed: { text: '蒸馏执行失败（原料未消费）', cls: 'mc-status-error' },
    },
    pendingTitle: '知识蒸馏提案 — 待确认',
    countText: cd => `${(cd?.materials as unknown[] | undefined)?.length || 0} 条原料`,
    approveLabel: '确认蒸馏',
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
            <div className="mc-time" style={{ marginBottom: 6 }}>命中信号：{signalParts.join('；')}</div>
          )}
          {materials?.map(m => (
            <div key={m.id} style={entryRowStyle}>
              <span className="mc-card-body" style={{ fontWeight: 600 }}>{m.title}</span>
            </div>
          ))}
          <div className="mc-time" style={{ marginBottom: 6 }}>
            预期产出：1–5 条蒸馏知识条目；确认后原料归档移出主区，拒绝则零副作用。
          </div>
        </>
      );
    },
  },

  // #144 知识库 GC 候选清单
  gc_proposal: {
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
          <div className="mc-time" style={{ marginBottom: 6 }}>
            {forced
              ? `主区 ${mainAreaCount ?? '—'} 条已超容量上限（200），强制出清单。`
              : '按蒸馏周期计龄：连续 3 个蒸馏周期零引用进候选。'}
          </div>
          {candidates?.map(c => (
            <div key={c.entryId} style={entryRowStyle}>
              <span className="mc-card-body" style={{ fontWeight: 600 }}>{c.title}</span>
              <div className="mc-time">{c.reason}</div>
            </div>
          ))}
          <div className="mc-time" style={{ marginBottom: 6 }}>
            确认后候选条目归档移出主区（可恢复）；拒绝则全部保留且后续不再提案。
          </div>
        </>
      );
    },
  },

  // #101 角色记忆（域端点 /role-memory/*，#353 接线后切通用端点）
  memory_proposal: {
    cardType: 'memory_proposal',
    kind: 'memory',
    approveAction: 'memory_proposal_approve',
    rejectAction: 'memory_proposal_reject',
    approvedState: 'approved',
    exec: async (cardData, decision) => {
      const roleId = typeof cardData?.roleId === 'string' ? cardData.roleId : '';
      const entries = cardData?.entries;
      const entryIds: string[] = Array.isArray(entries)
        ? entries
            .map((e: { draftId?: unknown }) => e?.draftId)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (!roleId || entryIds.length === 0) return false;
      const review = decision === 'approve' ? memoryApi.promote : memoryApi.demote;
      await review(roleId, entryIds);
      return true;
    },
    // 已审核态按草稿墓碑状态派生：全部 promoted → approved；全部 rejected → rejected；否则保持待审
    fetchReviewed: async cardData => {
      const roleId = typeof cardData?.roleId === 'string' ? cardData.roleId : '';
      const entries = cardData?.entries as MemoryEntry[] | undefined;
      if (!roleId || !entries?.length) return null;
      const { data } = await memoryApi.draftStatus(roleId, entries.map(e => e.draftId));
      const statuses = entries.map(e => data?.statuses?.[e.draftId]);
      if (statuses.every(s => s === 'promoted')) return 'approved';
      if (statuses.every(s => s === 'rejected')) return 'rejected';
      return null;
    },
    initialReviewed: metaStatusReviewed,
    reviewedTitle: '角色记忆',
    reviewLabels: {
      approved: { text: '已确认，已写入记忆', cls: 'mc-status-done' },
      rejected: { text: '已丢弃，未写入', cls: 'mc-status-error' },
    },
    pendingTitle: '角色记忆提案 — 待确认',
    countText: cd => `${(cd?.entries as unknown[] | undefined)?.length || 0} 条`,
    approveLabel: '确认写入',
    rejectLabel: '丢弃',
    renderContent: cd => {
      const entries = cd?.entries as MemoryEntry[] | undefined;
      const workUnitId = cd?.workUnitId as string | null | undefined;
      return (
        <>
          {entries?.map(e => (
            <div key={e.draftId} style={entryRowStyle}>
              <span className="mc-card-body" style={{ fontWeight: 600 }}>{e.title}</span>
              <span className="mc-status mc-status-pending" style={{ marginLeft: 6 }}>{MEMORY_KIND_LABELS[e.kind || ''] || e.kind}</span>
              {e.topicPath && (
                <div className="mc-time" style={{ marginBottom: 2 }}>将写入：{e.topicPath}</div>
              )}
            </div>
          ))}
          {workUnitId && (
            <div className="mc-time" style={{ marginBottom: 6 }}>来源 WorkUnit: {workUnitId}</div>
          )}
        </>
      );
    },
  },

  // 2026-07 知识审核闭环（域端点 /knowledge-service/*，#355 接线后切通用端点）
  knowledge_proposal: {
    cardType: 'knowledge_proposal',
    kind: 'knowledge',
    approveAction: 'knowledge_proposal_approve',
    rejectAction: 'knowledge_proposal_reject',
    approvedState: 'approved',
    exec: async (cardData, decision) => {
      const entries = cardData?.entries;
      const entryIds: string[] = Array.isArray(entries)
        ? entries
            .map((e: { id?: unknown }) => e?.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (entryIds.length === 0) return false;
      const review = decision === 'approve' ? knowledgeApi.promote : knowledgeApi.demote;
      await Promise.all(entryIds.map(entryId => review(entryId)));
      return true;
    },
    // 已审核态按条目 maturity 派生：全部非 draft/archived → approved；全部 archived → rejected；否则保持待审
    fetchReviewed: async cardData => {
      const entries = cardData?.entries as KnowledgeEntry[] | undefined;
      if (!entries?.length) return null;
      const maturities = await Promise.all(
        entries.map(async e => (await knowledgeApi.getEntry(e.id)).data?.maturity),
      );
      if (maturities.every(m => m && m !== 'draft' && m !== 'archived')) return 'approved';
      if (maturities.every(m => m === 'archived')) return 'rejected';
      return null;
    },
    initialReviewed: metaStatusReviewed,
    reviewedTitle: '知识提案',
    reviewLabels: {
      approved: { text: '已通过，参与注入', cls: 'mc-status-done' },
      rejected: { text: '已拒绝，已归档', cls: 'mc-status-error' },
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
            <div key={e.id} style={entryRowStyle}>
              <span className="mc-card-body" style={{ fontWeight: 600 }}>{e.title}</span>
              <span className="mc-status mc-status-pending" style={{ marginLeft: 6 }}>{KNOWLEDGE_TYPE_LABELS[e.type] || e.type}</span>
            </div>
          ))}
          {workUnitId && (
            <div className="mc-time" style={{ marginBottom: 6 }}>来源 WorkUnit: {workUnitId}</div>
          )}
        </>
      );
    },
  },

  // #146 存量约束审计（#288：「确认退役」两步确认）
  constraint_audit_proposal: {
    cardType: 'constraint_audit_proposal',
    kind: 'audit',
    approveAction: 'constraint_audit_approve',
    rejectAction: 'constraint_audit_reject',
    approvedState: 'executed',
    exec: proposalExec('auditProposalId', distillApi.auditApprove, distillApi.auditReject),
    fetchReviewed: proposalFetchReviewed('auditProposalId', distillApi.auditProposalStatus, ['executed', 'rejected']),
    reviewedTitle: '存量约束审计',
    reviewLabels: {
      executed: { text: '已确认，建议约束已退役（可回滚）', cls: 'mc-status-done' },
      rejected: { text: '已拒绝，约束全部保留', cls: 'mc-status-error' },
    },
    pendingTitle: '存量约束退役建议 — 待确认',
    countText: cd => `${(cd?.suggestions as unknown[] | undefined)?.length || 0} 条建议`,
    approveLabel: '确认退役',
    rejectLabel: '全部保留',
    twoStepApprove: true,
    armedApproveLabel: '再次点击确认退役',
    renderContent: cd => {
      const suggestions = cd?.suggestions as Array<{ constraintId: string; category: string; rationale: string }> | undefined;
      const auditedCount = cd?.auditedCount as number | undefined;
      return (
        <>
          <div className="mc-time" style={{ marginBottom: 6 }}>
            蒸馏产出新约束，顺带审计存量约束 {auditedCount ?? '—'} 条（判据：是否还有可被违反的未来场景）。
          </div>
          {suggestions?.map(s => (
            <div key={s.constraintId} style={entryRowStyle}>
              <span className="mc-card-body" style={{ fontWeight: 600 }}>{s.constraintId}</span>
              <span className="mc-time" style={{ marginLeft: 6 }}>{AUDIT_CATEGORY_LABELS[s.category] ?? s.category}</span>
              <div className="mc-time">{s.rationale}</div>
            </div>
          ))}
          <div className="mc-time" style={{ marginBottom: 6 }}>
            确认后走 retire 执行（retired 元数据留痕，可回滚）；拒绝则全部保留且后续不再提案。
          </div>
        </>
      );
    },
  },
};

/** action → 配置 + 决策方向（useChannelCardActions 参数化调用入口） */
export const PROPOSAL_ACTION_INDEX: Record<string, { config: ProposalCardConfig; decision: 'approve' | 'reject' }> =
  Object.fromEntries(
    Object.values(PROPOSAL_CARD_CONFIGS).flatMap(config => [
      [config.approveAction, { config, decision: 'approve' as const }],
      [config.rejectAction, { config, decision: 'reject' as const }],
    ]),
  );
