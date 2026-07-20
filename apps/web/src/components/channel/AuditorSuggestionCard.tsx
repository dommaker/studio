// Auditor suggestion card — B3-005
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘；交互语义零变更
import type { ChannelMessage } from '../../api/channel';

interface Props {
  message: ChannelMessage;
  meta: Record<string, any>;
  onAction: (messageId: string, action: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  param_tuning: '参数调优',
  prompt_optimization: 'Prompt 优化',
  skill_weight: 'Skill 权重',
  skill_status: 'Skill 发布',
};

export function AuditorSuggestionCard({ message, meta, onAction }: Props) {
  const status = meta.status as string | undefined;
  const suggestions = meta.cardData?.suggestions as Array<{
    type: string;
    risk: string;
    skillId?: string;
    skillName?: string;
    agentType?: string;
    detail: string;
    data?: Record<string, unknown>;
  }> | undefined;

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

      {/* Action buttons */}
      {status !== 'confirmed' && status !== 'rejected' && (
        <div className="mc-card-actions">
          <button
            onClick={() => onAction(message.id, 'auditor_apply_confirm')}
            className="mc-btn mc-btn-primary"
          >
            确认执行
          </button>
          <button
            onClick={() => onAction(message.id, 'auditor_apply_reject')}
            className="mc-btn"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
