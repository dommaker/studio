/**
 * PMO 号显示组件 - GEN-005
 * 
 * 显示格式：PM-001（带颜色状态）
 */

import React from 'react';

interface PmoNumberBadgeProps {
  pmoNumber: string;  // PM-001
  status?: 'pending' | 'active' | 'in_review' | 'completed' | 'cancelled';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

const statusColors: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  active: 'bg-blue-100 text-blue-700',
  in_review: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

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
  const baseClass = `inline-flex items-center rounded-full font-medium ${statusColors[status]} ${sizeStyles[size]}`;
  const clickableClass = onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : '';

  return (
    <span
      className={`${baseClass} ${clickableClass}`}
      onClick={onClick}
      title={`PMO 号: ${pmoNumber} | 状态: ${status}`}
    >
      <span className="mr-1">PM-</span>
      <span className="font-bold">{pmoNumber.replace('PM-', '')}</span>
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
  const handleClick = () => {
    if (projectId) {
      window.location.href = `/projects/${projectId}`;
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