// RoleCard — #348 下沉后的作战卡：三段式渲染 + 卡片级动态切片订阅 + memo 渲染边界
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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

const noop = () => {};
// memo props 稳定契约：对象字面量内联进 Host 会每次渲染新建引用、自己打破 memo（#348 issue 原文同款坑）
const EMPTY_CHANNELS: Record<string, string> = {};

function Host({ roles }: { roles: RosterRole[] }) {
  return (
    <>
      {roles.map((r) => (
        <RoleCard key={r.profile.id} role={r} lastDone={null} channelNames={EMPTY_CHANNELS} onTerminate={noop} />
      ))}
    </>
  );
}

describe('RoleCard', () => {
  beforeEach(() => {
    useRosterActivityStore.getState().resetActivities();
    for (const k of Object.keys(linkCount)) delete linkCount[k];
  });

  it('忙碌卡三段式：状态 pill + WU 标题链接 + CLI badge', () => {
    render(<Host roles={[busyRole('p1', 'dev-agent', 'wu-1', '实现登录接口')]} />);
    expect(screen.getByText('执行中')).toBeDefined();
    expect(screen.getByText('实现登录接口').closest('a')?.getAttribute('href')).toBe('/workunits/wu-1');
    expect(screen.getByText('CLI: claude')).toBeDefined();
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
