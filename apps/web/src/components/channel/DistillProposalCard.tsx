// Distill proposal card — #143 蒸馏提案人审闸口
// cardType 'distill_proposal'；action 'distill_proposal_approve' / 'distill_proposal_reject'
// （由 ChannelDetailPage.handleAction 分发到 /distill/approve、/distill/reject）
// 视觉复用 mc-card 族（仿 MemoryProposalCard / KnowledgeProposalCard）。
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

type ReviewState = 'executed' | 'rejected' | 'failed';

const REVIEW_LABELS: Record<ReviewState, { text: string; cls: string }> = {
  executed: { text: '已确认，蒸馏已执行', cls: 'mc-status-done' },
  rejected: { text: '已拒绝，本轮零副作用', cls: 'mc-status-error' },
  failed: { text: '蒸馏执行失败（原料未消费）', cls: 'mc-status-error' },
};

export function DistillProposalCard({ message, meta, onAction }: Props) {
  const proposalId = meta.cardData?.proposalId as string | undefined;
  const materials = meta.cardData?.materials as Array<{ id: string; title: string }> | undefined;
  const signals = meta.cardData?.signals as { topicTags?: string[]; manualCount?: number } | undefined;
  const [reviewed, setReviewed] = useState<ReviewState | null>(null);
  const [pending, setPending] = useState(false);

  // 已审态按提案状态派生（刷新/重进频道后仍正确）：executed/rejected/failed 均为终态；
  // 派生失败静默保持待审。对齐 MemoryProposalCard 按草稿墓碑派生的机制。
  useEffect(() => {
    if (reviewed || !proposalId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await distillApi.proposalStatus([proposalId]);
        if (cancelled) return;
        const status = data?.statuses?.[proposalId];
        if (status === 'executed' || status === 'rejected' || status === 'failed') setReviewed(status);
      } catch { /* 派生失败保持待审 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (action: 'distill_proposal_approve' | 'distill_proposal_reject') => {
    setPending(true);
    try {
      const ok = await onAction(message.id, action);
      if (ok !== false) setReviewed(action === 'distill_proposal_approve' ? 'executed' : 'rejected');
    } finally {
      setPending(false);
    }
  };

  if (reviewed) {
    const label = REVIEW_LABELS[reviewed];
    return (
      <div className="mc-card" data-card-type="distill_proposal">
        <div className="mc-card-label" style={{ marginBottom: 4 }}>知识蒸馏</div>
        <span className={`mc-status ${label.cls}`}>{label.text}</span>
      </div>
    );
  }

  const signalParts: string[] = [];
  if (signals?.topicTags?.length) signalParts.push(`同 topic/tag 新条目 ≥3（${signals.topicTags.join('、')}）`);
  if (signals?.manualCount) signalParts.push(`manual 过审新条目 ${signals.manualCount} 条`);

  return (
    <div className="mc-card" data-card-type="distill_proposal" style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">知识蒸馏提案 — 待确认</span>
        <span className="mc-status mc-status-need">{materials?.length || 0} 条原料</span>
      </div>

      {signalParts.length > 0 && (
        <div className="mc-time" style={{ marginBottom: 6 }}>命中信号：{signalParts.join('；')}</div>
      )}

      {/* 原料清单 */}
      {materials?.map(m => (
        <div key={m.id} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <span className="mc-card-body" style={{ fontWeight: 600 }}>{m.title}</span>
        </div>
      ))}

      <div className="mc-time" style={{ marginBottom: 6 }}>
        预期产出：1–5 条蒸馏知识条目；确认后原料归档移出主区，拒绝则零副作用。
      </div>

      {/* Action buttons */}
      <div className="mc-card-actions">
        <button
          onClick={() => act('distill_proposal_approve')}
          disabled={pending}
          className="mc-btn mc-btn-primary"
        >
          确认蒸馏
        </button>
        <button
          onClick={() => act('distill_proposal_reject')}
          disabled={pending}
          className="mc-btn"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
