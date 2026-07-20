// Knowledge proposal card — 2026-07 知识审核闭环（vision §4 提取→待审→注入，§6 人在频道审核）
// 契约（γ 轨道依赖，不得偏离）：cardType 'knowledge_proposal'；
// action 'knowledge_proposal_approve' / 'knowledge_proposal_reject'（由 ChannelDetailPage.handleAction 分发到 /promote、/demote）
// 交互模式仿 AuditorSuggestionCard；视觉复用 mc-card 族
import { useState } from 'react';
import type { ChannelMessage } from '../../api/channel';

interface Props {
  message: ChannelMessage;
  meta: Record<string, any>;
  /** approve/reject 由父级分发执行，返回是否成功（undefined 视为成功） */
  onAction: (messageId: string, action: string) => void | Promise<boolean>;
}

const TYPE_LABELS: Record<string, string> = {
  decision: '设计决策',
  pitfall: '踩坑记录',
  guideline: '最佳实践',
  model: '架构模式',
  process: '流程',
  architecture: '架构',
};

export function KnowledgeProposalCard({ message, meta, onAction }: Props) {
  const entries = meta.cardData?.entries as Array<{ id: string; title: string; type: string }> | undefined;
  const workUnitId = meta.cardData?.workUnitId as string | null | undefined;
  const [reviewed, setReviewed] = useState<'approved' | 'rejected' | null>(
    meta.status === 'approved' || meta.status === 'rejected' ? meta.status : null,
  );
  const [pending, setPending] = useState(false);

  const act = async (action: 'knowledge_proposal_approve' | 'knowledge_proposal_reject') => {
    setPending(true);
    try {
      const ok = await onAction(message.id, action);
      if (ok !== false) setReviewed(action === 'knowledge_proposal_approve' ? 'approved' : 'rejected');
    } finally {
      setPending(false);
    }
  };

  if (reviewed) {
    return (
      <div className="mc-card" data-card-type="knowledge_proposal">
        <div className="mc-card-label" style={{ marginBottom: 4 }}>知识提案</div>
        <span className={reviewed === 'approved' ? 'mc-status mc-status-done' : 'mc-status mc-status-error'}>
          {reviewed === 'approved' ? '已通过，参与注入' : '已拒绝，已归档'}
        </span>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type="knowledge_proposal" style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">知识提案 — 待审核</span>
        <span className="mc-status mc-status-need">{entries?.length || 0} 条知识</span>
      </div>

      {/* Entries（一次提取多条聚合一卡） */}
      {entries?.map(e => (
        <div key={e.id} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <span className="mc-card-body" style={{ fontWeight: 600 }}>{e.title}</span>
          <span className="mc-status mc-status-pending" style={{ marginLeft: 6 }}>{TYPE_LABELS[e.type] || e.type}</span>
        </div>
      ))}

      {workUnitId && (
        <div className="mc-time" style={{ marginBottom: 6 }}>来源 WorkUnit: {workUnitId}</div>
      )}

      {/* Action buttons */}
      <div className="mc-card-actions">
        <button
          onClick={() => act('knowledge_proposal_approve')}
          disabled={pending}
          className="mc-btn mc-btn-primary"
        >
          通过
        </button>
        <button
          onClick={() => act('knowledge_proposal_reject')}
          disabled={pending}
          className="mc-btn"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
