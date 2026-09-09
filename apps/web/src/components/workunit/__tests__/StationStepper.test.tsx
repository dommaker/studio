// #396：横向四站 stepper + 生命周期事件 chip 行
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { StationStepper, LifecycleEventChips } from '../StationStepper';
import { formatShortTime } from '../../../utils/datetime';
import type { WuStation, WuKeyEvent } from '../../../utils/wuLifecycle';

const t1 = formatShortTime('2026-07-30T09:00:00Z');
const t2 = formatShortTime('2026-07-30T09:30:00Z');
const t3 = formatShortTime('2026-07-30T10:00:00Z');

const stations: WuStation[] = [
  { id: 'claim', label: '待领取', time: '2026-07-30T09:00:00Z', state: 'done' },
  { id: 'progress', label: '进行中', time: '2026-07-30T09:30:00Z', state: 'current' },
  { id: 'review', label: '待验收', time: null, state: 'upcoming' },
  { id: 'done', label: '完成', time: null, state: 'upcoming' },
];

describe('StationStepper', () => {
  it('四站标签与已知时间戳渲染，无时间为 -', () => {
    render(<StationStepper stations={stations} />);
    expect(screen.getByText('待领取')).toBeDefined();
    expect(screen.getByText('进行中')).toBeDefined();
    expect(screen.getByText('待验收')).toBeDefined();
    expect(screen.getByText('完成')).toBeDefined();
    expect(screen.getByText(t1)).toBeDefined();
    expect(screen.getByText(t2)).toBeDefined();
    expect(screen.getAllByText('-').length).toBe(2);
  });

  it('站态 class：done/current/upcoming；当前站描边高亮', () => {
    const { container } = render(<StationStepper stations={stations} />);
    expect(screen.getByText('待领取').closest('.wu-bstep')?.className).toContain('wu-st-done');
    expect(screen.getByText('进行中').closest('.wu-bstep')?.className).toContain('wu-st-current');
    expect(screen.getByText('待验收').closest('.wu-bstep')?.className).toContain('wu-st-upcoming');
    // 连线：仅已达成站之后的线高亮（claim done → 1 条 reached）
    expect(container.querySelectorAll('.wu-bstep-line').length).toBe(3);
    expect(container.querySelectorAll('.wu-bstep-line-reached').length).toBe(1);
  });

  // E1：onStationClick 可选——不传纯展示（WU 详情页），传则站点可点（频道工作条开抽屉）
  it('不传 onStationClick → 纯展示（站点非按钮）', () => {
    const { container } = render(<StationStepper stations={stations} />);
    expect(container.querySelectorAll('button.wu-bstep').length).toBe(0);
    expect(container.querySelectorAll('.wu-bstep-btn').length).toBe(0);
  });

  it('传 onStationClick → 站点渲染为按钮，点击回调带站点', () => {
    const onStationClick = vi.fn();
    const { container } = render(<StationStepper stations={stations} onStationClick={onStationClick} />);
    const btns = container.querySelectorAll('button.wu-bstep.wu-bstep-btn');
    expect(btns.length).toBe(4);
    fireEvent.click(screen.getByText('待验收'));
    expect(onStationClick).toHaveBeenCalledWith(stations[2]);
  });
});

describe('LifecycleEventChips', () => {
  const events: WuKeyEvent[] = [
    { id: 'blocked', label: '阻塞', detail: 'stuck', time: '2026-07-30T10:00:00Z', tone: 'danger' },
    { id: 'l2', label: 'L2 Agent 评审通过', time: '2026-07-30T11:00:00Z', tone: 'accent' },
  ];

  it('chip = 色点 + 文字 + mono 时间；tone 上 class', () => {
    render(<LifecycleEventChips events={events} />);
    const blocked = screen.getByText('阻塞').closest('.wu-ev-chip');
    expect(blocked?.className).toContain('wu-ev-danger');
    expect(blocked?.getAttribute('title')).toBe('stuck');
    expect(screen.getByText('L2 Agent 评审通过').closest('.wu-ev-chip')?.className).toContain('wu-ev-accent');
    expect(screen.getByText(t3)).toBeDefined();
  });

  it('无事件不渲染（不占行）', () => {
    const { container } = render(<LifecycleEventChips events={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
