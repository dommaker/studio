/**
 * ProjectActivity tests - PMO 驾驶舱底部时间线
 * 覆盖：空态 / 四类条目渲染 / actorName 回退 / WU 标题点击跳转 / delivered 无 button
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ProjectActivity } from '../ProjectActivity';
import type { ProjectTimelineEntry } from '../pipelineUtils';

const entry = (
  over: Partial<ProjectTimelineEntry> & { id: string; kind: ProjectTimelineEntry['kind']; at: string },
): ProjectTimelineEntry => ({
  wuId: 'wu-1',
  title: '设计',
  ...over,
});

describe('ProjectActivity', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('空条目显示暂无动态', () => {
    render(<ProjectActivity entries={[]} />);
    expect(screen.getByText('暂无动态')).toBeInTheDocument();
  });

  it('created 条目渲染 "新增" + WU 标题 button', () => {
    const { container } = render(
      <ProjectActivity entries={[entry({ id: 'c1', kind: 'created', at: '2026-07-31T10:00:00' })]} />,
    );
    expect(container.textContent).toContain('新增');
    expect(screen.getByRole('button', { name: '「设计」' })).toBeInTheDocument();
  });

  it('claimed 条目带 actorName -> "dev 认领了"', () => {
    const { container } = render(
      <ProjectActivity entries={[entry({ id: 'cl1', kind: 'claimed', at: '2026-07-31T11:00:00', actorName: 'dev' })]} />,
    );
    expect(container.textContent).toContain('dev 认领了');
  });

  it('claimed 无 actorName -> 回退 "agent"', () => {
    const { container } = render(
      <ProjectActivity entries={[entry({ id: 'cl1', kind: 'claimed', at: '2026-07-31T11:00:00', actorName: null })]} />,
    );
    expect(container.textContent).toContain('agent 认领了');
  });

  it('completed 条目渲染 "完成（状态）"', () => {
    const { container } = render(
      <ProjectActivity entries={[entry({ id: 'cp1', kind: 'completed', at: '2026-07-31T12:00:00', status: 'done' })]} />,
    );
    expect(container.textContent).toContain('完成（已完成）');
  });

  it('delivered 条目渲染 "✓ 项目已交付"，无 button', () => {
    const { container } = render(
      <ProjectActivity
        entries={[entry({ id: 'd1', kind: 'delivered', at: '2026-07-31T13:00:00', wuId: undefined, title: undefined })]}
      />,
    );
    expect(container.textContent).toContain('✓ 项目已交付');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('WU 标题点击 navigate /workunits/:id', () => {
    render(<ProjectActivity entries={[entry({ id: 'c1', kind: 'created', at: '2026-07-31T10:00:00' })]} />);
    screen.getByRole('button', { name: '「设计」' }).click();
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-1');
  });
});
