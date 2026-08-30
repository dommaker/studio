// MonitorSection — #398 监控页区块容器（spec §7.5 文案定稿模式）
// 每区统一：标题（术语）+ 大白话副标题（--fs-xs muted）+ 可选 22px 主数字（--fs-stat + mono，视觉重点）。
import type { ReactNode } from 'react';

export function MonitorSection({ title, subtitle, stat, statTestId, children }: {
  title: string;
  /** 大白话副标题（防跨页词汇漂移：术语保留原名，白话解释跟在小字位） */
  subtitle?: string;
  /** 22px 主数字（每区至多一个视觉重点；表格区不传） */
  stat?: ReactNode;
  statTestId?: string;
  children: ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4" style={{ marginBottom: 10 }}>
        <div>
          <h2 className="mc-block-label" style={{ margin: 0 }}>{title}</h2>
          {subtitle && <p className="u-text-3" style={{ margin: '2px 0 0', fontSize: 'var(--fs-xs)' }}>{subtitle}</p>}
        </div>
        {stat !== undefined && (
          <span data-testid={statTestId} className="font-mono font-bold u-accent" style={{ fontSize: 'var(--fs-stat)', lineHeight: 1.2 }}>{stat}</span>
        )}
      </div>
      {children}
    </div>
  );
}
