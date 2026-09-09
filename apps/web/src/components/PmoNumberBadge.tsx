/**
 * PMO 号显示组件 - GEN-005
 * 
 * 原样显示 PMO 编号（PMO-<n>，带颜色状态），不拼前缀 —— #432 C1
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { PROJECT_STATUS_COLORS, PROJECT_STATUS_LABELS } from './pmo/projectDisplay';

interface PmoNumberBadgeProps {
  pmoNumber: string;  // PMO-1
  status?: 'pending' | 'active' | 'in_review' | 'completed' | 'cancelled';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

const sizeStyles: Record<string, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
  lg: 'px-4 py-2 text-base',
};

export function PmoNumberBadge({
  pmoNumber,
  status = 'pending',
  size = 'md',
  onClick,
}: PmoNumberBadgeProps) {
  const baseClass = `inline-flex items-center rounded-full font-medium ${PROJECT_STATUS_COLORS[status] ?? 'u-surface-2 u-text'} ${sizeStyles[size]}`;
  const clickableClass = onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : '';

  return (
    <span
      className={`${baseClass} ${clickableClass}`}
      onClick={onClick}
      title={`PMO 号: ${pmoNumber} | 状态: ${PROJECT_STATUS_LABELS[status] ?? status}`}
    >
      <span className="font-bold">{pmoNumber}</span>
    </span>
  );
}

/**
 * PMO 号链接组件（可点击跳转到项目详情）
 */
export function PmoNumberLink({
  pmoNumber,
  status,
  projectId,
}: PmoNumberBadgeProps & { projectId?: string }) {
  const navigate = useNavigate();
  const handleClick = () => {
    if (projectId) {
      // #474：项目详情唯一入口 /pmo/project/:id（/project/ 旧路由由 App 重定向兜底）
      navigate(`/pmo/project/${projectId}`);
    }
  };

  return (
    <PmoNumberBadge
      pmoNumber={pmoNumber}
      status={status}
      onClick={projectId ? handleClick : undefined}
    />
  );
}

export default PmoNumberBadge;