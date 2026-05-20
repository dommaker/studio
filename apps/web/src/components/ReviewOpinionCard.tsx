// ReviewOpinionCard.tsx - 审核意见卡片
import type { ReviewOpinion } from './MultiStanceReviewPanel';
import { StanceBadge } from './StanceBadge';

// 审核结果配置
const REVIEW_RESULTS = {
  approve: { label: '支持', icon: '✅', color: '#4CAF50' },
  reject: { label: '反对', icon: '❌', color: '#F44336' },
  neutral: { label: '中立', icon: '⚖️', color: '#2196F3' },
  conditional: { label: '有条件支持', icon: '⚠️', color: '#FF9800' },
};

interface ReviewOpinionCardProps {
  opinion: ReviewOpinion;
  selected?: boolean;
  onClick?: () => void;
  compact?: boolean;
}

export function ReviewOpinionCard({
  opinion,
  selected,
  onClick,
  compact = false,
}: ReviewOpinionCardProps) {
  const resultInfo = REVIEW_RESULTS[opinion.result];

  if (compact) {
    // 简洁模式
    return (
      <div
        onClick={onClick}
        className="review-opinion-card-compact flex items-center gap-2 p-2 rounded cursor-pointer"
        style={{
          background: selected ? 'var(--bg-hover)' : 'var(--bg-secondary)',
          border: selected ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
        }}
      >
        <StanceBadge stance={opinion.stance} size="sm" />
        <span className="text-sm font-bold">{opinion.roleName}</span>
        <span style={{ color: resultInfo.color }}>{resultInfo.icon}</span>
      </div>
    );
  }

  // 完整模式
  return (
    <div
      onClick={onClick}
      className="review-opinion-card p-4 rounded cursor-pointer transition-all"
      style={{
        background: selected ? 'var(--bg-hover)' : 'var(--bg-secondary)',
        border: selected ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
      }}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StanceBadge stance={opinion.stance} />
          <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
            {opinion.roleName}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}
          >
            {opinion.roleType}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="px-2 py-1 rounded text-sm font-bold"
            style={{ background: resultInfo.color + '20', color: resultInfo.color }}
          >
            {resultInfo.icon} {resultInfo.label}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {new Date(opinion.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* 详细意见 */}
      <div
        className="opinion-text p-3 rounded mb-3"
        style={{ background: 'var(--bg-primary)' }}
      >
        <p style={{
          fontSize: '14px',
          lineHeight: '1.6',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
        }}>
          {opinion.opinion}
        </p>
      </div>

      {/* 建议列表 */}
      {opinion.suggestions && opinion.suggestions.length > 0 && (
        <div className="suggestions">
          <div className="text-xs font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
            💡 建议
          </div>
          <ul className="space-y-1">
            {opinion.suggestions.map((suggestion, index) => (
              <li
                key={index}
                className="flex items-start gap-2 text-sm"
                style={{ color: 'var(--text-secondary)' }}
              >
                <span style={{ color: 'var(--accent-primary)' }}>•</span>
                <span>{suggestion}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}