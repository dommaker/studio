// #116: BlockedByList — 依赖（blockedBy）清单共享组件契约测试
// 消费方：WorkUnitListPage 行内展开（被阻塞行）/ WorkUnitDetailPage「依赖与验收」卡
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
}));

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../../../api/workunit', () => ({
  workunitApi: { get: mockGet },
}));

import { BlockedByList } from '../BlockedByList';

function depWu(id: string, status: string, title?: string) {
  return {
    data: {
      id,
      status,
      scope: `scope-of-${id}`,
      metadata: title ? JSON.stringify({ title }) : null,
    },
  };
}

describe('BlockedByList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('metadata 为 null / 无 blockedBy → 不渲染任何内容', () => {
    const { container } = render(<BlockedByList metadata={null} />);
    expect(container.innerHTML).toBe('');
    const { container: c2 } = render(<BlockedByList metadata={JSON.stringify({ pmoId: 'p1' })} />);
    expect(c2.innerHTML).toBe('');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('渲染依赖行：标题 + 状态 chip + 跳详情页链接', async () => {
    mockGet.mockResolvedValue(depWu('wu-dep-1', 'active', '依赖任务一'));
    render(<BlockedByList metadata={JSON.stringify({ blockedBy: ['wu-dep-1'] })} />);
    await waitFor(() => expect(screen.getByText('依赖任务一')).toBeDefined());
    const link = screen.getByText('依赖任务一').closest('a');
    expect(link?.getAttribute('href')).toBe('/workunits/wu-dep-1');
    expect(screen.getByText('进行中')).toBeDefined();
  });

  it('metadata.title 缺失时回退 scope', async () => {
    mockGet.mockResolvedValue(depWu('wu-dep-1', 'done'));
    render(<BlockedByList metadata={JSON.stringify({ blockedBy: ['wu-dep-1'] })} />);
    await waitFor(() => expect(screen.getByText('scope-of-wu-dep-1')).toBeDefined());
  });

  it('了结（done/closed）用 u-ok 样式，未了结用 u-warn 样式', async () => {
    mockGet.mockImplementation((id: string) =>
      Promise.resolve(depWu(id, id === 'wu-done' ? 'done' : 'unassigned')),
    );
    render(<BlockedByList metadata={JSON.stringify({ blockedBy: ['wu-done', 'wu-open'] })} />);
    await waitFor(() => expect(screen.getByText('已完成')).toBeDefined());
    expect(screen.getByText('已完成').className).toContain('u-ok');
    expect(screen.getByText('待认领').className).toContain('u-warn');
  });

  it('依赖拉取失败（已删/笔误）→ 「找不到这张单」按未了结展示（保守阻塞 #109 口径）', async () => {
    mockGet.mockRejectedValue(new Error('404'));
    render(<BlockedByList metadata={JSON.stringify({ blockedBy: ['wu-gone'] })} />);
    await waitFor(() => expect(screen.getByText('找不到这张单')).toBeDefined());
    expect(screen.getByText('找不到这张单').className).toContain('u-warn');
    // 缺失 id 仍给跳转链接（人工修正 metadata 用）
    const link = screen.getByText('wu-gone', { exact: false }).closest('a');
    expect(link?.getAttribute('href')).toBe('/workunits/wu-gone');
  });
});
