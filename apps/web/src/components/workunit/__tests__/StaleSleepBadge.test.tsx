// StaleSleepBadge — #464「已沉睡」徽标
// 契约：unassigned ∧ metadata.staleGuardBlockedAt === updatedAt → 显示「已沉睡」；
// 其余（复活/其他状态/无标记/标记与 updatedAt 不一致）→ 不渲染
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StaleSleepBadge } from '../StaleSleepBadge';

const STALE_ISO = '2026-09-01T00:00:00.000Z';

function wu(overrides: Partial<{ status: string; updatedAt: string; metadata: string | null }> = {}) {
  return {
    status: 'unassigned',
    updatedAt: STALE_ISO,
    metadata: JSON.stringify({ staleGuardBlockedAt: STALE_ISO }),
    ...overrides,
  };
}

describe('StaleSleepBadge（#464）', () => {
  it('沉睡中（unassigned + 标记 === updatedAt）→ 显示「已沉睡」', () => {
    render(<StaleSleepBadge wu={wu()} />);
    expect(screen.getByText('已沉睡')).toBeTruthy();
  });

  it('复活（updatedAt 被外部写刷新，≠ 落盘标记）→ 不渲染', () => {
    const { container } = render(<StaleSleepBadge wu={wu({ updatedAt: '2026-09-09T00:00:00.000Z' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('非 unassigned 状态 → 不渲染', () => {
    const { container } = render(<StaleSleepBadge wu={wu({ status: 'active' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('无标记 / metadata 缺失 / metadata 损坏 → 不渲染', () => {
    expect(render(<StaleSleepBadge wu={wu({ metadata: null })} />).container.firstChild).toBeNull();
    expect(render(<StaleSleepBadge wu={wu({ metadata: '{}' })} />).container.firstChild).toBeNull();
    expect(render(<StaleSleepBadge wu={wu({ metadata: '{broken' })} />).container.firstChild).toBeNull();
  });
});
