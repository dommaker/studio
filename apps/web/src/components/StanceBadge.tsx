// StanceBadge.tsx - 立场徽章组件
import { useState } from 'react';

// 立场配置（与 DiscussionDriver 统一）
// 分组：赞成方(advocate, pragmatist, executor, visionary) | 反对方(skeptic, reviewer, architect) | 中立方(neutral)
// 颜色按 group 归并到语义 token（docs/specs/ui/style-guide.md §2：禁止写死颜色）
const STANCES = {
  advocate: { name: '倡导者', icon: '📢', desc: '论证方案可行性，提供证据', group: 'proponent' },
  skeptic: { name: '质疑者', icon: '🔍', desc: '找出潜在问题，提出替代方案', group: 'opponent' },
  neutral: { name: '中立者', icon: '⚖️', desc: '客观分析各方观点，指出风险', group: 'neutral' },
  pragmatist: { name: '实用主义者', icon: '🔧', desc: '关注实施成本、时间线', group: 'proponent' },
  visionary: { name: '远见者', icon: '🚀', desc: '关注长期影响、战略价值', group: 'proponent' },
  executor: { name: '执行者', icon: '⚙️', desc: '关注任务分配、验收标准', group: 'proponent' },
  reviewer: { name: '审查者', icon: '📋', desc: '确保质量合规性', group: 'opponent' },
  architect: { name: '架构师', icon: '🏗️', desc: '评估技术方案架构影响', group: 'opponent' },
};

// 立场分组 → 徽章配色（dim 底 + 语义文字色，深浅色主题自动适配）
const GROUP_STYLES: Record<string, { background: string; color: string }> = {
  proponent: { background: 'var(--success-dim)', color: 'var(--success)' },
  opponent: { background: 'var(--error-dim)', color: 'var(--error)' },
  neutral: { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
};

interface StanceBadgeProps {
  stance: keyof typeof STANCES;
  size?: 'sm' | 'md' | 'lg';
  showDesc?: boolean;
  onClick?: () => void;
}

export function StanceBadge({
  stance,
  size = 'md',
  showDesc = false,
  onClick,
}: StanceBadgeProps) {
  const stanceInfo = STANCES[stance];
  const groupStyle = GROUP_STYLES[stanceInfo.group];
  const [showTooltip, setShowTooltip] = useState(false);

  // 尺寸配置
  const sizeConfig = {
    sm: { padding: '2px 8px', fontSize: '12px', iconSize: '14px' },
    md: { padding: '4px 12px', fontSize: '14px', iconSize: '16px' },
    lg: { padding: '6px 16px', fontSize: '16px', iconSize: '18px' },
  };

  const config = sizeConfig[size];

  return (
    <div
      className="stance-badge"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: config.padding,
        borderRadius: '12px',
        background: groupStyle.background,
        color: groupStyle.color,
        fontSize: config.fontSize,
        fontWeight: 'bold',
        cursor: onClick ? 'pointer' : 'default',
        position: 'relative',
      }}
    >
      <span style={{ fontSize: config.iconSize }}>{stanceInfo.icon}</span>
      <span>{stanceInfo.name}</span>

      {/* Tooltip */}
      {showTooltip && !showDesc && (
        <div
          className="stance-tooltip"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '8px',
            padding: '8px 12px',
            borderRadius: '8px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-md)',
            whiteSpace: 'nowrap',
            zIndex: 100,
          }}
        >
          <div className="text-sm font-bold" style={{ color: groupStyle.color }}>
            {stanceInfo.icon} {stanceInfo.name}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            {stanceInfo.desc}
          </div>
        </div>
      )}

      {/* 显示描述 */}
      {showDesc && (
        <span
          className="stance-desc ml-2"
          style={{ color: 'var(--text-secondary)', fontWeight: 'normal' }}
        >
          · {stanceInfo.desc}
        </span>
      )}
    </div>
  );
}

// 导出立场配置供其他组件使用
export { STANCES };