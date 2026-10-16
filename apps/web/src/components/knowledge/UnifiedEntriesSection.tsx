// 拆分来源：pages/KnowledgePage.tsx 统一视图条目列表 + 追加式分页页脚整块（E5-3，纯 JSX 平移）
import type { UnifiedEntry } from '../../api/knowledge';
import { UnifiedEntryCard } from './UnifiedEntryCard';

export interface UnifiedEntriesSectionProps {
  entries: UnifiedEntry[];
  total: number;
  /** E5-1：draft 条目审批 pending 锁存 */
  actingIds: Set<string>;
  onReview: (entryId: string, action: 'approve' | 'reject') => void;
  /** E5-3 追加式分页：请求中锁存 */
  moreLoading: boolean;
  onLoadMore: () => void;
}

/** 统一视图条目列表（卡片 map）+ E5-3 追加式分页页脚（对齐 E2 WU 列表口径） */
export function UnifiedEntriesSection({ entries, total, actingIds, onReview, moreLoading, onLoadMore }: UnifiedEntriesSectionProps) {
  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <UnifiedEntryCard key={entry.id || i} entry={entry} acting={actingIds.has(entry.id)} onReview={onReview} />
      ))}
      {/* E5-3：追加式分页页脚（对齐 E2 WU 列表口径） */}
      <div className="text-center mt-4">
        {total > entries.length && (
          <button onClick={onLoadMore} disabled={moreLoading} className="btn btn-secondary">
            {moreLoading ? '加载中...' : '加载更多'}
          </button>
        )}
        <div className="text-xs mt-2 u-text-3">已加载 {entries.length} / 共 {total}</div>
      </div>
    </div>
  );
}
