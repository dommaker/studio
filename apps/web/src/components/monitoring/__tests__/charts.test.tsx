// Contract test: charts — #398 监控页图表小组件（spec §7.4：div/CSS 手搓，零图表库，承 #396 先例）
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { UsageBar, DayBars, HBars } from '../charts';

describe('UsageBar — 预算用量条', () => {
  it('填充宽度 = usedPct（封顶 100%），预算内为 accent 色', () => {
    render(<UsageBar usedPct={42} />);
    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill.style.width).toBe('42%');
    expect(fill.style.background).toContain('--accent-primary');
  });

  it('≥70% 黄色预警、>100% 红色越线（宽度仍封顶 100）', () => {
    const { rerender } = render(<UsageBar usedPct={85} />);
    expect(screen.getByTestId('usage-bar-fill').style.background).toContain('--warning');
    rerender(<UsageBar usedPct={130} />);
    const fill = screen.getByTestId('usage-bar-fill');
    expect(fill.style.background).toContain('--error');
    expect(fill.style.width).toBe('100%');
  });

  it('caption 渲染为说明小字', () => {
    render(<UsageBar usedPct={10} caption="已用 1.2k / 预算 3k" />);
    expect(screen.getByText('已用 1.2k / 预算 3k')).toBeDefined();
  });
});

describe('DayBars — byDay 柱图', () => {
  it('柱高 = 命中率%，日期标签取 MM-DD，null 渲染为空柱', () => {
    render(<DayBars data={[
      { day: '2026-08-27', value: 50 },
      { day: '2026-08-28', value: null },
      { day: '2026-08-29', value: 100 },
    ]} />);
    const bars = screen.getAllByTestId('day-bar-fill');
    expect(bars[0].style.height).toBe('50%');
    expect(bars[1].style.height).toBe('0%');
    expect(bars[2].style.height).toBe('100%');
    expect(screen.getByText('08-27')).toBeDefined();
    expect(screen.getByText('08-29')).toBeDefined();
  });

  it('空数组不渲染任何柱', () => {
    const { container } = render(<DayBars data={[]} />);
    expect(container.querySelectorAll('[data-testid="day-bar-fill"]')).toHaveLength(0);
  });
});

describe('HBars — 横条', () => {
  it('条宽 = value%（0–100 口径），label 与值同行', () => {
    render(<HBars data={[
      { label: 'Analyst', value: 75 },
      { label: 'Executor', value: null },
    ]} />);
    const fills = screen.getAllByTestId('hbar-fill');
    expect(fills[0].style.width).toBe('75%');
    expect(fills[1].style.width).toBe('0%');
    expect(screen.getByText('Analyst')).toBeDefined();
    expect(screen.getByText('75%')).toBeDefined();
    expect(screen.getByText('N/A')).toBeDefined();
  });
});
