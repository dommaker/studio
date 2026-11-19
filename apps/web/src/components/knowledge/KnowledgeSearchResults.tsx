// 拆分来源：pages/KnowledgePage.tsx 搜索态结果卡整块（E5-2 搜索态替换 tab 内容区，纯 JSX 平移）
import type { KnowledgeSearchResult } from '../../api/knowledge';
import { CONSUMPTION_MODE_CHART } from '../../utils/knowledgeContent';

export interface KnowledgeSearchResultsProps {
  results: KnowledgeSearchResult[];
  onClear: () => void;
}

/** S11 全局搜索结果卡（类型徽标去 emoji——类别色文字 + 中性底，无映射归中性） */
export function KnowledgeSearchResults({ results, onClear }: KnowledgeSearchResultsProps) {
  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium u-text">
          搜索结果 ({results.length})
        </span>
        <button onClick={onClear} className="u-btn-reset text-xs u-text-3">清除</button>
      </div>
      {results.length === 0 ? (
        <div className="empty-state text-sm">无匹配结果</div>
      ) : (
        <div className="space-y-2">
          {results.map((r, i) => {
            // E5-5：类型徽标去 emoji，与统一视图同源——类别色文字 + 中性底，无映射归中性
            const chartIdx = CONSUMPTION_MODE_CHART[r.type];
            return (
            <div key={`${r.type}-${r.id}-${i}`} className="card p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
                  style={chartIdx != null ? { color: `var(--chart-${chartIdx})` } : undefined}>
                  {r.type}
                </span>
                <span className="font-medium text-sm u-text">{r.title}</span>
              </div>
              <p className="text-xs u-text-3">{r.snippet}</p>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
