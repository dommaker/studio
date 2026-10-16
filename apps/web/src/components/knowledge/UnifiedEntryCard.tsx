// 拆分来源：pages/KnowledgePage.tsx 统一视图条目卡（map 回调体内整块，纯 JSX 平移；
// chartIdx/isDraft 派生随本体走）
import type { UnifiedEntry } from '../../api/knowledge';
import { UnifiedEntryContent } from './UnifiedEntryContent';
import { MATURITY_BADGE_CLASSES } from './GapCards';
import { CONSUMPTION_MODE_CHART } from '../../utils/knowledgeContent';

export interface UnifiedEntryCardProps {
  entry: UnifiedEntry;
  /** E5-1：draft 条目审批 pending 锁存 */
  acting: boolean;
  /** E5-1: draft 条目审批——approve=promote / reject=demote */
  onReview: (entryId: string, action: 'approve' | 'reject') => void;
}

/** 统一视图单条知识卡（成熟度/类别/来源徽标 + 正文摘要 + 标签 + draft 审批按钮） */
export function UnifiedEntryCard({ entry, acting, onReview }: UnifiedEntryCardProps) {
  // #435：类别维度不占状态色（§6.5）——chart 类别色文字 + 中性底，无映射归中性
  const chartIdx = CONSUMPTION_MODE_CHART[entry.consumptionMode ?? ''];
  const isDraft = entry.maturity === 'draft';
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        {/* E5-1：成熟度徽标（词表复用 ResolutionCard 状态色 MATURITY_BADGE_CLASSES） */}
        {entry.maturity && (
          <span className={`text-xs px-2 py-0.5 rounded ${MATURITY_BADGE_CLASSES[entry.maturity] || 'u-surface-2 u-text-3'}`}>
            {entry.maturity}
          </span>
        )}
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
          style={chartIdx != null ? { color: `var(--chart-${chartIdx})` } : undefined}>
          {entry.consumptionMode}
        </span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">
          {entry.source}
        </span>
        <span className="font-medium text-sm u-text">{entry.title}</span>
      </div>
      {/* draft 条目不显全文——UnifiedEntryContent 默认截断/消化摘要，审批按钮在卡底 */}
      <UnifiedEntryContent content={entry.content} />
      {(entry.tags?.length ?? 0) > 0 && (
        <div className="flex gap-1 flex-wrap">
          {(entry.tags ?? []).map((tag: string) => (
            <span key={tag} className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-3">
              {tag}
            </span>
          ))}
        </div>
      )}
      {isDraft && (
        <div className="flex gap-2 mt-2">
          <button className="btn btn-primary btn-sm" disabled={acting}
            onClick={() => onReview(entry.id, 'approve')}>
            {acting ? '处理中…' : '通过'}
          </button>
          <button className="btn btn-secondary btn-sm" disabled={acting}
            onClick={() => onReview(entry.id, 'reject')}>
            {acting ? '处理中…' : '拒绝'}
          </button>
        </div>
      )}
    </div>
  );
}
