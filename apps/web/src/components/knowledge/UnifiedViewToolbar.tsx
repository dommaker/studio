// 拆分来源：pages/KnowledgePage.tsx 统一视图筛选/工具行整块（AS-022 + E5-1，纯 JSX 平移）
import { Select } from '../ui';

export interface UnifiedViewToolbarProps {
  mode: string;
  onModeChange: (mode: string) => void;
  /** E5-1：「待审」筛选（maturity=draft，/knowledge/unified 原生支持 maturity 参数） */
  reviewOnly: boolean;
  onToggleReview: () => void;
  total: number;
  showForm: boolean;
  onToggleForm: () => void;
}

/** 统一视图工具行：类型筛选 + 待审筛选 + 条数 + 新建入口 */
export function UnifiedViewToolbar({ mode, onModeChange, reviewOnly, onToggleReview, total, showForm, onToggleForm }: UnifiedViewToolbarProps) {
  return (
    <div className="flex gap-2 mb-4">
      <Select value={mode} onChange={onModeChange}
        options={[
          { value: '', label: '全部类型' },
          { value: 'rule', label: '规则 (rule)' },
          { value: 'context', label: '上下文 (context)' },
          { value: 'signal', label: '信号 (signal)' },
          { value: 'reference', label: '参考 (reference)' },
        ]} />
      {/* E5-1：「待审」筛选（maturity=draft） */}
      <button onClick={onToggleReview}
        className={`btn btn-sm ${reviewOnly ? 'btn-primary' : 'btn-secondary'}`}>
        待审
      </button>
      <span className="text-sm self-center u-text-3">
        {total} 条
      </span>
      <button onClick={onToggleForm} className="ml-auto btn btn-primary">
        {showForm ? '取消' : '+ 新建'}
      </button>
    </div>
  );
}
