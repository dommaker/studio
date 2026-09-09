// ProjectCard 测试（#472）：项目状态词上卡片（原来卡片无状态词）+ 交付策略走唯一词表（原裸 auto-merge）
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import { ProjectCard } from '../ProjectCard';
import type { Project } from '../types';

const project = (over: Partial<Project>): Project => ({
  id: 'p1',
  pmoNumber: 'PMO-1',
  title: '测试项目',
  status: 'active',
  progress: 40,
  createdAt: '2026-09-01T00:00:00Z',
  ...over,
});

const noop = () => {};

describe('ProjectCard（#472 状态词与交付策略词表）', () => {
  it('卡片显示中文状态词（active → 开发中），不裸英文', () => {
    render(<ProjectCard project={project({ status: 'active' })} wuStats={{}} channels={[]} handlePublishClick={noop} />);
    expect(screen.getByText('开发中')).toBeTruthy();
    expect(screen.queryByText('active')).toBeNull();
  });

  it('交付策略走唯一词表：auto-merge → 自动合并，不渲染裸策略值', () => {
    render(
      <ProjectCard project={project({ deliveryPolicy: 'auto-merge' })} wuStats={{}} channels={[]} handlePublishClick={noop} />,
    );
    expect(screen.getByText(/自动合并/)).toBeTruthy();
    expect(screen.queryByText(/auto-merge/)).toBeNull();
  });

  it('branch-only → 分支交付', () => {
    render(
      <ProjectCard project={project({ deliveryPolicy: 'branch-only' })} wuStats={{}} channels={[]} handlePublishClick={noop} />,
    );
    expect(screen.getByText(/分支交付/)).toBeTruthy();
    expect(screen.queryByText(/branch-only/)).toBeNull();
  });

  it('cancelled 状态 → 已取消', () => {
    render(<ProjectCard project={project({ status: 'cancelled' })} wuStats={{}} channels={[]} handlePublishClick={noop} />);
    expect(screen.getByText('已取消')).toBeTruthy();
  });
});
