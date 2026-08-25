// ConstraintAuditCard — #146 存量约束退役建议人审闸口
// cardType 'constraint_audit_proposal'；action 'constraint_audit_approve' / 'constraint_audit_reject'
// （由 ChannelDetailPage.handleAction 分发到 /review-proposals/audit/:id/approve、…/reject）
// 视觉复用 mc-card 族（仿 GcProposalCard）。
// #288（清单 P2 #20）：「确认退役」为高危操作 → acknowledge→confirm 两步确认
// （首次点击仅进入待确认态，再次点击才执行；点全部保留或执行失败退出待确认态）。
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
  executed: { text: '已确认，建议约束已退役（可回滚）', cls: 'mc-status-done' },
  rejected: { text: '已拒绝，约束全部保留', cls: 'mc-status-error' },
};

const CATEGORY_LABELS: Record<string, string> = {
  'target-gone': '作用对象已消失',
  'reintroduction-sealed': '再引入路径已封死',
};

interface AuditSuggestionItem {
  constraintId: string;
  category: string;
  rationale: string;
}

export function ConstraintAuditCard({ message, meta, onAction }: Props) {
  const auditProposalId = meta.cardData?.auditProposalId as string | undefined;
  const suggestions = meta.cardData?.suggestions as AuditSuggestionItem[] | undefined;
  const auditedCount = meta.cardData?.auditedCount as number | undefined;
  const [reviewed, setReviewed] = useState<ReviewState | null>(null);
  const [pending, setPending] = useState(false);
  // #288：「确认退役」两步确认——armed=true 表示已进入待确认态，再次点击才执行
  const [armed, setArmed] = useState(false);

  // 已审态按提案状态派生（刷新/重进频道后仍正确）：executed/rejected 均为终态；
  // 派生失败静默保持待审。对齐 GcProposalCard 机制。
  useEffect(() => {
    if (reviewed || !auditProposalId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await distillApi.auditProposalStatus([auditProposalId]);
        if (cancelled) return;
        const status = data?.statuses?.[auditProposalId];
        if (status === 'executed' || status === 'rejected') setReviewed(status);
      } catch { /* 派生失败保持待审 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (action: 'constraint_audit_approve' | 'constraint_audit_reject') => {
    setPending(true);
    try {
      const ok = await onAction(message.id, action);
      if (ok !== false) setReviewed(action === 'constraint_audit_approve' ? 'executed' : 'rejected');
    } finally {
      setPending(false);
      // #288：执行完毕（含失败重武装）退出两步确认待确认态
      setArmed(false);
    }
  };

  if (reviewed) {
    const label = REVIEW_LABELS[reviewed];
    return (
      <div className="mc-card" data-card-type="constraint_audit_proposal">
        <div className="mc-card-label" style={{ marginBottom: 4 }}>存量约束审计</div>
        <span className={`mc-status ${label.cls}`}>{label.text}</span>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type="constraint_audit_proposal" style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">存量约束退役建议 — 待确认</span>
        <span className="mc-status mc-status-need">{suggestions?.length || 0} 条建议</span>
      </div>

      <div className="mc-time" style={{ marginBottom: 6 }}>
        蒸馏产出新约束，顺带审计存量约束 {auditedCount ?? '—'} 条（判据：是否还有可被违反的未来场景）。
      </div>

      {/* 建议清单（逐条附判据 + 理由） */}
      {suggestions?.map(s => (
        <div key={s.constraintId} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <span className="mc-card-body" style={{ fontWeight: 600 }}>{s.constraintId}</span>
          <span className="mc-time" style={{ marginLeft: 6 }}>{CATEGORY_LABELS[s.category] ?? s.category}</span>
          <div className="mc-time">{s.rationale}</div>
        </div>
      ))}

      <div className="mc-time" style={{ marginBottom: 6 }}>
        确认后走 retire 执行（retired 元数据留痕，可回滚）；拒绝则全部保留且后续不再提案。
      </div>

      {/* Action buttons（#288：确认退役两步确认 + pending 锁存禁用防连击） */}
      <div className="mc-card-actions">
        <button
          onClick={() => (armed ? void act('constraint_audit_approve') : setArmed(true))}
          disabled={pending}
          className="mc-btn mc-btn-primary"
        >
          {armed ? '再次点击确认退役' : '确认退役'}
        </button>
        <button
          onClick={() => { setArmed(false); void act('constraint_audit_reject'); }}
          disabled={pending}
          className="mc-btn"
        >
          全部保留
        </button>
      </div>
    </div>
  );
}
