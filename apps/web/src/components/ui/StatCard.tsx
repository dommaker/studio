import React from 'react';

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  color: string;
  /**
   * 布局变体（两页存量渲染输出本不同，收敛时各自原样保留）：
   * 'card' = E7 归一配方（.card 容器 + --fs-stat mono 数字 + u-text-2 标签，AuditLogsPage）；
   * 'inline' = MonitoringPage 横向行式（值与标签同行）
   */
  variant?: 'card' | 'inline';
}

/** 统计卡（原 AuditLogsPage/MonitoringPage 双份本地拷贝收敛为 ui 一份） */
export function StatCard({ label, value, color, variant = 'card' }: StatCardProps) {
  if (variant === 'inline') {
    return (
      <div className="flex items-center gap-2">
        <span className={`font-bold ${color}`} style={{ fontSize: 'var(--fs-stat)' }}>{value}</span>
        <span className="text-sm u-text-2">{label}</span>
      </div>
    );
  }
  return (
    <div className="card p-4">
      <div style={{ fontSize: 'var(--fs-stat)' }} className={`font-mono font-bold ${color}`}>{value}</div>
      <div className="text-sm u-text-2">{label}</div>
    </div>
  );
}
