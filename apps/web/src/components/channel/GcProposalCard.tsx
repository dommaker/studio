// GC proposal card — #144 知识库 GC 候选清单人审闸口
// cardType 'gc_proposal'；action 'gc_proposal_approve' / 'gc_proposal_reject'
// （由 ChannelDetailPage.handleAction 分发到 /review-proposals/gc/:id/approve、…/reject）
// 视觉复用 mc-card 族（仿 DistillProposalCard）。
import { useEffect, useState } from 'react';
import type { ChannelMessage } from '../../api/channel';
import { distillApi } from '../../api/distill';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  /** approve/reject 由父级分发执行，返回是否成功（undefined 视为成功） */
  onAction: (messageId: string, action: string) => void | Promise<boolean>;
}

type ReviewState = 'executed' | 'rejected';

const REVIEW_LABELS: Record<ReviewState, { text: string; cls: string }> = {
  executed: { text: '已确认，候选条目已归档', cls: 'mc-status-done' },
  rejected: { text: '已拒绝，条目全部保留', cls: 'mc-status-error' },
};

interface GcCandidateItem {
  entryId: string;
  title: string;
  reason: string;
}

export function GcProposalCard({ message, meta, onAction }: Props) {
  const gcProposalId = meta.cardData?.gcProposalId as string | undefined;
  const candidates = meta.cardData?.candidates as GcCandidateItem[] | undefined;
  const forced = meta.cardData?.forced as boolean | undefined;
  const mainAreaCount = meta.cardData?.mainAreaCount as number | undefined;
  const [reviewed, setReviewed] = useState<ReviewState | null>(null);
  const [pending, setPending] = useState(false);

  // 已审态按提案状态派生（刷新/重进频道后仍正确）：executed/rejected 均为终态；
  // 派生失败静默保持待审。对齐 DistillProposalCard 机制。
  useEffect(() => {
    if (reviewed || !gcProposalId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await distillApi.gcProposalStatus([gcProposalId]);
        if (cancelled) return;
        const status = data?.statuses?.[gcProposalId];
        if (status === 'executed' || status === 'rejected') setReviewed(status);
      } catch { /* 派生失败保持待审 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (action: 'gc_proposal_approve' | 'gc_proposal_reject') => {
    setPending(true);
    try {
      const ok = await onAction(message.id, action);
      if (ok !== false) setReviewed(action === 'gc_proposal_approve' ? 'executed' : 'rejected');
    } finally {
      setPending(false);
    }
  };

  if (reviewed) {
    const label = REVIEW_LABELS[reviewed];
    return (
      <div className="mc-card" data-card-type="gc_proposal">
        <div className="mc-card-label" style={{ marginBottom: 4 }}>知识库 GC</div>
        <span className={`mc-status ${label.cls}`}>{label.text}</span>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type="gc_proposal" style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">知识库 GC 候选清单 — 待确认</span>
        <span className="mc-status mc-status-need">{candidates?.length || 0} 条候选</span>
      </div>

      <div className="mc-time" style={{ marginBottom: 6 }}>
        {forced
          ? `主区 ${mainAreaCount ?? '—'} 条已超容量上限（200），强制出清单。`
          : '按蒸馏周期计龄：连续 3 个蒸馏周期零引用进候选。'}
      </div>

      {/* 候选清单（逐条附可读理由） */}
      {candidates?.map(c => (
        <div key={c.entryId} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <span className="mc-card-body" style={{ fontWeight: 600 }}>{c.title}</span>
          <div className="mc-time">{c.reason}</div>
        </div>
      ))}

      <div className="mc-time" style={{ marginBottom: 6 }}>
        确认后候选条目归档移出主区（可恢复）；拒绝则全部保留且后续不再提案。
      </div>

      {/* Action buttons */}
      <div className="mc-card-actions">
        <button
          onClick={() => act('gc_proposal_approve')}
          disabled={pending}
          className="mc-btn mc-btn-primary"
        >
          确认归档
        </button>
        <button
          onClick={() => act('gc_proposal_reject')}
          disabled={pending}
          className="mc-btn"
        >
          全部保留
        </button>
      </div>
    </div>
  );
}
