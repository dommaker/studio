// Contract test: MonitorSection — #398 监控页区块容器（§7.5：标题 + 白话副标题 + 22px 主数字）
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MonitorSection } from '../MonitorSection';

describe('MonitorSection', () => {
  it('渲染标题 + 大白话副标题 + 主数字（--fs-stat + mono）+ 子内容', () => {
    render(
      <MonitorSection title="证据台账（信任分层）" subtitle="每个任务有多少人/机器确认过" stat="83%" statTestId="evidence-stat">
        <div>区内容</div>
      </MonitorSection>,
    );
    expect(screen.getByText('证据台账（信任分层）')).toBeDefined();
    expect(screen.getByText('每个任务有多少人/机器确认过')).toBeDefined();
    const stat = screen.getByTestId('evidence-stat');
    expect(stat.textContent).toBe('83%');
    expect(stat.style.fontSize).toBe('var(--fs-stat)');
    expect(stat.className).toContain('font-mono');
    expect(screen.getByText('区内容')).toBeDefined();
  });

  it('不传 stat/subtitle 时不渲染对应元素（表格区无主数字）', () => {
    render(<MonitorSection title="角色效率"><div>表</div></MonitorSection>);
    expect(screen.getByText('角色效率')).toBeDefined();
    expect(screen.getByText('表')).toBeDefined();
    expect(document.querySelector('[data-testid]')).toBeNull();
  });
});
