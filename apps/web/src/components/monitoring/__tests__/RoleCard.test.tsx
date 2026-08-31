// RoleCard — #397 信息全卡（redesign §6.1 四层构成 + §6.5 状态色单义）；
// 保留 #348 渲染边界契约：memo + 卡片自订 rosterActivityStore 切片（chunk 只重渲对应卡）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import React from 'react';

const { linkCount } = vi.hoisted(() => ({ linkCount: {} as Record<string, number> }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) => {
    if (typeof to === 'string' && to.startsWith('/agents/')) linkCount[to] = (linkCount[to] ?? 0) + 1;
    return React.createElement('a', { href: to, ...rest }, children);
  },
}));

import { RoleCard } from '../RoleCard';
import { useRosterActivityStore } from '../../../stores/rosterActivityStore';
import type { RosterRole } from '../../../hooks/useAgentRoster';

const busyRole = (id: string, name: string, wuId: string, wuTitle: string): RosterRole => ({
  profile: { id, name, description: '', status: 'active', provider: 'claude', isOnline: true, lastError: null },
  runtime: {
    id: `i-${id}`, roleId: id, name, status: 'active', currentWorkUnitId: wuId,
    currentWorkUnit: { id: wuId, title: wuTitle, type: 'DEV', status: 'active', claimedAt: '2026-08-28T00:00:00Z' },
    channelId: null, pmo: null, startedAt: '2026-08-28T00:00:00Z', lastError: null, lastErrorAt: null,
  },
} as unknown as RosterRole);

const idleRole = (id: string, name: string): RosterRole => ({
  profile: { id, name, description: '', status: 'active', provider: 'kimi', isOnline: true, lastError: null },
  runtime: {
    id: `i-${id}`, roleId: id, name, status: 'idle', currentWorkUnitId: null, currentWorkUnit: null,
    channelId: null, pmo: null, startedAt: '2026-08-28T00:00:00Z', lastError: null, lastErrorAt: null,
  },
} as unknown as RosterRole);

// memo props 稳定契约：对象字面量内联进 Host 会每次渲染新建引用、自己打破 memo（#348 issue 原文同款坑）
const EMPTY_CHANNELS: Record<string, string> = {};

function Host({ roles }: { roles: RosterRole[] }) {
  return (
    <>
      {roles.map((r) => (
        <RoleCard key={r.profile.id} role={r} lastDone={null} channelNames={EMPTY_CHANNELS} />
      ))}
    </>
  );
}

describe('RoleCard（信息全卡）', () => {
  beforeEach(() => {
    useRosterActivityStore.getState().resetActivities();
    for (const k of Object.keys(linkCount)) delete linkCount[k];
  });

  it('四层构成：头行（pill/角色名链接/CLI chip/运行时长）→ WU 锚点+类型 chip+已耗时 → 动态区 → 无错误行', () => {
    render(<Host roles={[busyRole('p1', 'dev-agent', 'wu-1', '实现登录接口')]} />);
    const card = screen.getByText('实现登录接口').closest('[data-testid="agent-card"]') as HTMLElement;
    expect(card.getAttribute('data-status')).toBe('running');
    expect(within(card).getByText('执行中')).toBeDefined();
    expect(within(card).getByText('dev-agent').closest('a')?.getAttribute('href')).toBe('/agents/p1');
    expect(within(card).getByText('claude')).toBeDefined();
    expect(within(card).getByText('实现登录接口').closest('a')?.getAttribute('href')).toBe('/workunits/wu-1');
    expect(within(card).getByText('DEV')).toBeDefined();
    expect(within(card).getByText(/已耗时/)).toBeDefined();
    expect(within(card).queryByText(/^⚠/)).toBeNull();
  });

  it('空闲空态：等待派活 + 最近完成链接', () => {
    const roles = [idleRole('p1', 'ops-agent')];
    render(
      <RoleCard
        role={roles[0]}
        lastDone={{ id: 'wu-9', scope: '修好的首页' } as never}
        channelNames={EMPTY_CHANNELS}
      />,
    );
    expect(screen.getByText(/空闲 · 等待派活/)).toBeDefined();
    expect(screen.getByText('修好的首页').closest('a')?.getAttribute('href')).toBe('/workunits/wu-9');
  });

  it('异常空态：实例异常文案 + 错误行（⚠ lastError，随 data-status=error 同色）', () => {
    const role = idleRole('p1', 'ops-agent');
    role.runtime!.status = 'error';
    role.runtime!.lastError = 'spawn ENOENT';
    const { container } = render(<RoleCard role={role} lastDone={null} channelNames={EMPTY_CHANNELS} />);
    expect(screen.getByText(/实例异常/)).toBeDefined();
    const err = screen.getByText(/⚠ spawn ENOENT/);
    expect(err.className).toContain('agd-error');
    expect(container.querySelector('[data-testid="agent-card"]')?.getAttribute('data-status')).toBe('error');
  });

  it('最近动态最多 3 条（新→旧），每条可点：有当前 WU → WU 详情', async () => {
    render(<Host roles={[busyRole('p1', 'dev-agent', 'wu-1', '实现登录接口')]} />);
    act(() => {
      for (let i = 1; i <= 4; i++) {
        useRosterActivityStore.getState().appendActivity('p1', { at: `t${i}`, key: `s${i}`, text: `第${i}条动态` });
      }
    });
    expect(await screen.findByText('第4条动态')).toBeDefined();
    expect(screen.getByText('第3条动态')).toBeDefined();
    expect(screen.getByText('第2条动态')).toBeDefined();
    expect(screen.queryByText('第1条动态')).toBeNull();
    expect(screen.getByText('第4条动态').closest('a')?.getAttribute('href')).toBe('/workunits/wu-1');
  });

  it('无当前 WU 时动态落点 = 角色详情（交互不断链）', async () => {
    render(<Host roles={[idleRole('p1', 'ops-agent')]} />);
    act(() => {
      useRosterActivityStore.getState().appendActivity('p1', { at: 't', key: 's', text: '收尾记录' });
    });
    const row = await screen.findByText('收尾记录');
    expect(row.closest('a')?.getAttribute('href')).toBe('/agents/p1');
  });

  it('渲染边界（#348）：同 props rerender 被 memo 拦下；本卡 chunk 重渲、他卡零重渲', async () => {
    const roles = [busyRole('p1', 'dev-agent', 'wu-1', '实现登录接口'), busyRole('p2', 'ops-agent', 'wu-2', '清理定时任务')];
    const { rerender } = render(<Host roles={roles} />);
    expect(linkCount['/agents/p1']).toBe(1);
    expect(linkCount['/agents/p2']).toBe(1);

    // 页面级重渲（props 引用全不变）→ memo 跳过两张卡
    rerender(<Host roles={roles} />);
    expect(linkCount['/agents/p1']).toBe(1);
    expect(linkCount['/agents/p2']).toBe(1);

    // p1 的动态 chunk → 仅 p1 卡重渲且最新动态可见，p2 卡不动
    act(() => useRosterActivityStore.getState().appendActivity('p1', { at: 't', key: 'stream:2:thinking', text: '思考：动手改造' }));
    expect(await screen.findByText(/思考：动手改造/)).toBeDefined();
    expect(linkCount['/agents/p1']).toBe(2);
    expect(linkCount['/agents/p2']).toBe(1);
  });
});
