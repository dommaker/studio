/**
 * ProjectPipeline tests - PMO 进度管道
 * 覆盖：loading / 空态 / 进度条+五泳道计数 / WU 卡片标题 / agent 名册解析 / assigneeId 回退
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
  it('loading 态显示加载中', () => {
    render(<ProjectPipeline workunits={[]} agents={[]} loading={true} />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('空 WU 列表显示暂无产出', () => {
    render(<ProjectPipeline workunits={[]} agents={[]} />);
    expect(screen.getByText('暂无任务产出')).toBeInTheDocument();
  });

  it('渲染总进度条与五泳道计数（#399 词表：待领取/进行中/待验收/完成）', () => {
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

  it('WU 卡片点击 navigate /workunits/:id', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务', status: 'active' })]} agents={[]} />);
    screen.getByText('任务').click();
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/a');
  });
});
