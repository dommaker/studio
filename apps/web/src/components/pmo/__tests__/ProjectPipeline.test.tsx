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
    expect(screen.getByText('暂无 WorkUnit 产出')).toBeInTheDocument();
  });

  it('渲染总进度条与五泳道计数', () => {
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
    expect(screen.getByText(/1\/3 WU 完成/)).toBeInTheDocument();
    expect(screen.getByText(/待认领 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/执行中 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/已完成 \(1\)/)).toBeInTheDocument();
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

  it('无 assigneeId -> 显示未认领', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务', status: 'unassigned', assigneeId: null })]} agents={[]} />);
    expect(screen.getByText('未认领')).toBeInTheDocument();
  });

  it('WU 卡片点击 navigate /workunits/:id', () => {
    render(<ProjectPipeline workunits={[wu({ id: 'a', title: '任务', status: 'active' })]} agents={[]} />);
    screen.getByText('任务').click();
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/a');
  });
});
