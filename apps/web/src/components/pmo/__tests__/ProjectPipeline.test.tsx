/**
 * ProjectPipeline tests - PMO 进度管道
 * 覆盖：loading / 空态 / 进度条+泳道计数 / 泳道列数对齐 / WU 卡片标题 / agent 名册解析 / assigneeId 回退
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ProjectPipeline } from '../ProjectPipeline';
import type { AgentInfo } from '../../../api/monitoring';
import type { PipelineWorkUnit } from '../pipelineUtils';

const wu = (over: Partial<PipelineWorkUnit> & { id: string }): PipelineWorkUnit => ({
  title: '任务',
  status: 'unassigned',
  assigneeId: null,
  metadata: '{}',
  ...over,
});

const agent = (over: Partial<AgentInfo> & { id: string }): AgentInfo => ({
  roleId: 'role-1',
  name: 'dev',
  status: 'idle',
  currentWorkUnitId: null,
  startedAt: '2026-07-31T00:00:00Z',
  ...over,
});

describe('ProjectPipeline', () => {
  it('loading 态渲染静态骨架（批次 E-2，替代纯文字「加载中」）', () => {
    const { container } = render(<ProjectPipeline workunits={[]} agents={[]} loading={true} />);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText('加载中...')).toBeNull();
  });

  it('空 WU 列表显示暂无产出', () => {
    render(<ProjectPipeline workunits={[]} agents={[]} />);
    expect(screen.getByText('暂无任务产出')).toBeInTheDocument();
  });

  it('渲染总进度条与泳道计数（#399 词表：待领取/进行中/待验收/完成）', () => {
    render(
      <ProjectPipeline
        workunits={[
          wu({ id: 'a', title: '任务A', status: 'active' }),
          wu({ id: 'b', title: '任务B', status: 'unassigned' }),
          wu({ id: 'c', title: '任务C', status: 'done' }),
        ]}
        agents={[]}
      />,
    );
    expect(screen.getByText(/1\/3 任务完成/)).toBeInTheDocument();
    expect(screen.getByText(/待领取 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/进行中 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/完成 \(1\)/)).toBeInTheDocument();
  });

  it('#432 B0-1：泳道 grid 列数与实际泳道数（6）对齐，第 6 条「完成」不掉行', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务A', status: 'done' })]} agents={[]} />);
    const grid = screen.getByText(/完成 \(1\)/).closest('.grid');
    expect(grid).not.toBeNull();
    expect(grid!.className).not.toContain('grid-cols-5');
    expect((grid as HTMLElement).style.gridTemplateColumns).toContain('repeat(6');
  });

  it('#432 B2：进度条 token 化——中间态 u-accent-bg、100% u-ok-bg，无写死蓝色', () => {
    const { container, rerender } = render(
      <ProjectPipeline
        workunits={[wu({ id: 'a', title: '任务A', status: 'active' }), wu({ id: 'b', title: '任务B', status: 'done' })]}
        agents={[]}
      />,
    );
    const fill = container.querySelector('.h-3 > div') as HTMLElement;
    expect(fill.className).toContain('u-accent-bg');
    expect(fill.className).not.toMatch(/from-blue|to-blue/);

    rerender(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务A', status: 'done' })]} agents={[]} />);
    const fillDone = container.querySelector('.h-3 > div') as HTMLElement;
    expect(fillDone.className).toContain('u-ok-bg');
  });

  it('#399 §8.1：0 桶 muted 自然呈现——泳道不染状态色、桶名 muted；非 0 桶维持色语义', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务A', status: 'blocked' })]} agents={[]} />);

    // 非 0 阻塞泳道：红语义保留
    const blockedHead = screen.getByText(/阻塞 \(1\)/);
    expect(blockedHead.className).toContain('u-err');
    expect(blockedHead.parentElement!.className).toContain('u-err-dim');

    // 0 桶泳道：不加整泳道染色，桶名 muted
    const emptyHead = screen.getByText(/待验收 \(0\)/);
    expect(emptyHead.className).toContain('u-text-3');
    expect(emptyHead.className).not.toContain('u-warn');
    expect(emptyHead.parentElement!.className).not.toContain('u-warn-dim');
  });

  it('WU 卡片标题渲染', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '实现登录', status: 'active' })]} agents={[]} />);
    expect(screen.getByText('实现登录')).toBeInTheDocument();
  });

  it('assigneeId 匹配 agent 名册 -> 显示 agent name（可点击）', () => {
    render(
      <ProjectPipeline
        workunits={[wu({ id: 'a', title: '任务', status: 'active', assigneeId: 'inst-1' })]}
        agents={[agent({ id: 'inst-1', name: 'dev' })]}
      />,
    );
    expect(screen.getByRole('button', { name: 'dev' })).toBeInTheDocument();
  });

  it('assigneeId 无匹配 -> 显示 @前8位', () => {
    render(
      <ProjectPipeline
        workunits={[wu({ id: 'a', title: '任务', status: 'active', assigneeId: 'inst-12345678' })]}
        agents={[]}
      />,
    );
    expect(screen.getByText('@inst-123')).toBeInTheDocument();
  });

  it('无 assigneeId -> 显示未领取', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务', status: 'unassigned', assigneeId: null })]} agents={[]} />);
    expect(screen.getByText('未领取')).toBeInTheDocument();
  });

  it('#472：pending「待确认」收口 wu-display 中性色（与 in_review 待验收 warning 区分开）', () => {
    render(
      <ProjectPipeline
        workunits={[
          wu({ id: 'a', title: '任务A', status: 'pending' }),
          wu({ id: 'b', title: '任务B', status: 'in_review' }),
        ]}
        agents={[]}
      />,
    );

    // 泳道头：非 0 桶仍走中性色（不再 u-warn）
    const pendingHead = screen.getByText(/待确认 \(1\)/);
    expect(pendingHead.className).not.toContain('u-warn');

    // WU 卡状态 chip：消费 WU_STATUS_COLORS（pending = 中性 surface，非 warn）
    const chip = screen.getByText('待确认', { selector: 'span.rounded' });
    expect(chip.className).toContain('u-surface-2');
    expect(chip.className).not.toContain('u-warn');

    // in_review 侧保持 warning 不变（语义对照组）
    const reviewChip = screen.getByText('待验收', { selector: 'span.rounded' });
    expect(reviewChip.className).toContain('u-warn');
  });

  it('WU 卡片点击 navigate /workunits/:id', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务', status: 'active' })]} agents={[]} />);
    screen.getByText('任务').click();
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/a');
  });
});
