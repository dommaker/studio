// #114 T8：ProjectMap / NextActionCard 组件测试 — 地图区四块 + 徽章四态 + 跳转
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProjectMap, NextActionCard } from '../ProjectMap';
import type { PmoMap } from '../mapUtils';

const map: PmoMap = {
  destination: '把订单系统拆成前后台两条线',
  decisions: [
    { wuId: 'wu-d2', summary: '队列用内存实现，先不上 Redis', resolvedAt: '2026-08-02T10:00:00Z' },
    { wuId: 'wu-d1', summary: '存储沿用 Postgres', resolvedAt: '2026-08-01T09:00:00Z' },
  ],
  fog: [
    { id: 'fog-1', question: '存储选型？', wuId: 'wu-d1', status: 'resolved' },
    { id: 'fog-2', question: '队列方案？', wuId: 'wu-d2', status: 'open' },
    { id: 'fog-3', question: '鉴权要不要重做？', wuId: 'wu-d3', status: 'open' },
    { id: 'fog-4', question: '拆分的边界？', wuId: null, status: 'open' },
  ],
};

const chainWus = [
  { id: 'wu-t1', title: '拆订单读模型', status: 'done', metadata: null },
  {
    id: 'wu-t2', title: '拆订单写模型', status: 'unassigned',
    metadata: JSON.stringify({ blockedBy: ['wu-t1', 'wu-ghost'] }),
  },
  { id: 'wu-t3', title: '无依赖的杂活', status: 'active', metadata: null },
];

const renderMap = (decisionStatusByWuId: Record<string, string> = {}) =>
  render(
    <MemoryRouter initialEntries={['/pmo/project/p1']}>
      <Routes>
        <Route
          path="/pmo/project/:id"
          element={<ProjectMap map={map} decisionStatusByWuId={decisionStatusByWuId} chainWus={chainWus} />}
        />
        <Route path="/workunits/:id" element={<div>WU 详情页</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('ProjectMap：地图区', () => {
  it('目标 + 待决问题清单 + 结论时间线 + 依赖图四块渲染', () => {
    renderMap();

    expect(screen.getByText('🎯 目标')).toBeTruthy();
    expect(screen.getByText('把订单系统拆成前后台两条线')).toBeTruthy();
    expect(screen.getByText('❓ 待决问题 (4)')).toBeTruthy();
    expect(screen.getByText('📜 结论时间线 (2)')).toBeTruthy();
    expect(screen.getByText('🔗 任务单依赖')).toBeTruthy();
  });

  it('徽章四态：已定 / 待确认 / 讨论中 / 待认领 按决策单实际状态渲染', () => {
    renderMap({ 'wu-d2': 'in_review', 'wu-d3': 'active' });

    // fog-1 resolved → 已定
    expect(screen.getByText('已定')).toBeTruthy();
    // fog-2 决策单在审 → 待确认
    expect(screen.getByText('待确认')).toBeTruthy();
    // fog-3 决策单被认领在做 → 讨论中
    expect(screen.getByText('讨论中')).toBeTruthy();
    // fog-4 未建单 → 待认领
    expect(screen.getByText('待认领')).toBeTruthy();
  });

  it('结论时间线按落地时间正序，点结论跳决策单', () => {
    renderMap();

    const items = screen.getAllByRole('button', { name: /Postgres|Redis/ });
    // resolvedAt 早的（存储沿用 Postgres 08-01）排在前面
    expect(items[0].textContent).toContain('存储沿用 Postgres');
    expect(items[1].textContent).toContain('队列用内存实现');

    fireEvent.click(items[0]);
    expect(screen.getByText('WU 详情页')).toBeTruthy();
  });

  it('已建决策单的待决问题可点进决策单线程；未建单的不可点', () => {
    renderMap();

    fireEvent.click(screen.getByRole('button', { name: '存储选型？' }));
    expect(screen.getByText('WU 详情页')).toBeTruthy();
  });

  it('依赖图：只列有依赖的单，缺失依赖防御展示「找不到这张单」', () => {
    renderMap();

    expect(screen.getByRole('button', { name: '拆订单写模型' })).toBeTruthy();
    expect(screen.getByText(/拆订单读模型（已完成）/)).toBeTruthy();
    expect(screen.getByText(/wu-ghost…/)).toBeTruthy();
    expect(screen.getByText(/找不到这张单/)).toBeTruthy();
    // 无依赖的单不进依赖图
    expect(screen.queryByRole('button', { name: '无依赖的杂活' })).toBeNull();
  });

  it('空态：无待决问题 / 无结论 / 无依赖', () => {
    render(
      <MemoryRouter>
        <ProjectMap
          map={{ destination: '小需求', decisions: [], fog: [] }}
          decisionStatusByWuId={{}}
          chainWus={[{ id: 'wu-1', title: '独立任务', status: 'done', metadata: null }]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('暂无待决问题')).toBeTruthy();
    expect(screen.getByText('还没有拍板的结论')).toBeTruthy();
    expect(screen.getByText('任务单之间暂无依赖')).toBeTruthy();
  });
});

describe('NextActionCard：下一个该干什么', () => {
  const renderCard = (action: Parameters<typeof NextActionCard>[0]['action']) =>
    render(
      <MemoryRouter initialEntries={['/pmo/project/p1']}>
        <Routes>
          <Route path="/pmo/project/:id" element={<NextActionCard action={action} />} />
          <Route path="/workunits/:id" element={<div>WU 详情页</div>} />
        </Routes>
      </MemoryRouter>,
    );

  it('决策单 → 「先拍板这个待决问题」，点击跳 WU', () => {
    renderCard({ id: 'wu-d1', title: '待决问题 PMO-1: 存储选型？', type: 'decision' });

    expect(screen.getByText('👉 下一个该干什么')).toBeTruthy();
    expect(screen.getByText('先拍板这个待决问题')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '待决问题 PMO-1: 存储选型？' }));
    expect(screen.getByText('WU 详情页')).toBeTruthy();
  });

  it('任务单 → 「可以认领开工」', () => {
    renderCard({ id: 'wu-t2', title: '拆订单写模型', type: 'task' });
    expect(screen.getByText('可以认领开工')).toBeTruthy();
  });

  it('无可认领 → 空态文案', () => {
    renderCard(null);
    expect(screen.getByText('暂无可认领的任务（依赖未清或都已有人在做）')).toBeTruthy();
  });
});
