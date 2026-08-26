// Auditor suggestion card — B3-005
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘；交互语义零变更
// #288（清单 P2 #20）：按钮一次性锁存——点击到状态回流窗口期禁用防连击，失败重武装可重试；
// 成功后本地定终态（对齐 ReviewProposalCard 等提案卡先例范式）。
import { useState } from 'react';
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  onAction: (messageId: string, action: string) => void | Promise<boolean>;
}

const TYPE_LABELS: Record<string, string> = {
  param_tuning: '参数调优',
  prompt_optimization: 'Prompt 优化',
  skill_weight: 'Skill 权重',
  skill_status: 'Skill 发布',
};

export function AuditorSuggestionCard({ message, meta, onAction }: Props) {
  // #288：成功后本地定终态（不赖 refresh 回流窗口）；失败（ok===false）不进终态
  const [done, setDone] = useState<'confirmed' | 'rejected' | null>(null);
  // #288：pending 锁存——点击到 onAction 回流前按钮禁用，防连击重复触发
  const [pending, setPending] = useState(false);
  const status = done ?? (meta.status as string | undefined);
  const suggestions = meta.cardData?.suggestions as Array<{
    type: string;
    risk: string;
    skillId?: string;
    skillName?: string;
    agentType?: string;
    detail: string;
    data?: Record<string, unknown>;
  }> | undefined;

  const act = async (action: 'auditor_apply_confirm' | 'auditor_apply_reject') => {
    setPending(true);
    try {
      const ok = await onAction(message.id, action);
      if (ok !== false) setDone(action === 'auditor_apply_confirm' ? 'confirmed' : 'rejected');
    } finally {
      // 失败重武装：pending 复位后按钮恢复可点，可重试
      setPending(false);
    }
  };

  if (status === 'confirmed' || status === 'rejected') {
    return (
      <div className="mc-card" data-card-type="auditor_suggestion">
        <div className="mc-card-label" style={{ marginBottom: 4 }}>审计建议</div>
        <span className={status === 'confirmed' ? 'mc-status mc-status-done' : 'mc-status mc-status-error'}>
          {status === 'confirmed' ? '已确认执行' : '已拒绝'}
        </span>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type="auditor_suggestion" style={{ borderColor: 'var(--warning-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">审计建议 — 待确认</span>
        <span className="mc-status mc-status-running">{suggestions?.length || 0} 条建议</span>
      </div>

      {/* Suggestions */}
      {suggestions?.map((s, i) => (
        <div key={i} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="mc-card-body" style={{ fontWeight: 600 }}>
              {TYPE_LABELS[s.type] || s.type}
            </span>
            {s.risk === 'high' && (
              <span className="mc-status mc-status-error">高风险</span>
            )}
          </div>
          <p className="mc-card-dim" style={{ marginTop: 2 }}>{s.detail}</p>
          {s.agentType && (
            <span className="mc-time">Agent: {s.agentType}</span>
          )}
        </div>
      ))}

      {/* Action buttons（#288：pending 锁存禁用防连击） */}
      {status !== 'confirmed' && status !== 'rejected' && (
        <div className="mc-card-actions">
          <button
            onClick={() => void act('auditor_apply_confirm')}
            disabled={pending}
            className="mc-btn mc-btn-primary"
          >
            确认执行
          </button>
          <button
            onClick={() => void act('auditor_apply_reject')}
            disabled={pending}
            className="mc-btn"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
