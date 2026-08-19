// Knowledge confirm / retract card — B1-008/B1-010
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘；交互语义零变更
// #278（决策 #250 D2）：knowledge_confirm 产卡链已删（历史卡）→ 按钮区整区隐藏 + 卡底淡注；
// retract_confirm 按钮接活（POST /skills/:id/retract/decide）。
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  onAction: (messageId: string, action: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  decision: '设计决策',
  pitfall: '踩坑记录',
  guideline: '最佳实践',
  model: '架构模式',
};

export function KnowledgeConfirmCard({ message, meta, onAction }: Props) {
  const isRetract = meta.cardType === 'retract_confirm';
  const status = meta.status as string | undefined;
  const entries = meta.cardData?.entries as Array<{
    type: string;
    title: string;
    content: string;
    tags: string[];
  }> | undefined;

  if (status === 'confirmed' || status === 'rejected' || status === 'deprecated' || status === 'published') {
    const okState = status === 'confirmed' || status === 'published';
    return (
      <div className="mc-card" data-card-type={meta.cardType}>
        <div className="mc-card-label" style={{ marginBottom: 4 }}>{isRetract ? '撤回确认' : '知识收录'}</div>
        <span className={okState ? 'mc-status mc-status-done' : status === 'deprecated' ? 'mc-status mc-status-pending' : 'mc-status mc-status-error'}>
          {isRetract
            ? (status === 'deprecated' ? '已确认废弃' : '撤回已取消，保持发布')
            : (status === 'confirmed' ? '已确认入库' : status === 'published' ? '已确认入库' : '已拒绝')}
        </span>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type={meta.cardType} style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">
          {isRetract ? '撤回确认' : '知识收录确认'}
        </span>
        {/* #278：retract 卡 cardData 携带 skillId/skillName（无 entries），头部 chip 按卡型分流 */}
        <span className="mc-status mc-status-need">
          {isRetract ? String(meta.cardData?.skillName ?? '未知技能') : `${entries?.length || 0} 条知识`}
        </span>
      </div>

      {/* Entries */}
      {entries?.map((entry, i) => (
        <div key={i} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <p className="mc-card-body" style={{ fontWeight: 600 }}>{entry.title}</p>
          <p className="mc-card-dim" style={{ marginTop: 2 }}>{entry.content}</p>
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            <span className="mc-wu-link">{TYPE_LABELS[entry.type] || entry.type}</span>
            {entry.tags?.map(tag => (
              <span key={tag} className="mc-status mc-status-pending">{tag}</span>
            ))}
          </div>
        </div>
      ))}

      {/* #278（决策 #250 D2）：knowledge_confirm 产卡链已删，历史卡按钮区整区隐藏 + 卡底淡注；
          retract_confirm 按钮接活（retract/decide 端点） */}
      {isRetract && status !== 'confirmed' && status !== 'rejected' && status !== 'deprecated' && status !== 'published' ? (
        <div className="mc-card-actions">
          <button
            onClick={() => onAction(message.id, 'retract_confirm')}
            className="mc-btn mc-btn-warn"
          >
            确认废弃
          </button>
          <button
            onClick={() => onAction(message.id, 'retract_reject')}
            className="mc-btn"
          >
            拒绝
          </button>
        </div>
      ) : !isRetract ? (
        <div className="mc-card-foot mc-card-dim" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          该确认入口已下线
        </div>
      ) : null}
    </div>
  );
}
