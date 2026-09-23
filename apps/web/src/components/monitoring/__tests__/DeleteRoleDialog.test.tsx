// DeleteRoleDialog — #630（ADR 2026-09-23 决策 5）：删除确认框列在途任务
// （标题 + 状态词 + PMO 项目名/「未归属」，点击跳任务详情）；有在途任务允许删除但警告
// 「这些任务会中断，等待系统自动回收」；终态（done/completed/closed）不进清单。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const { mockWuList, mockDeleteAgent, mockResolveWuPmoBatch } = vi.hoisted(() => ({
  mockWuList: vi.fn(),
  mockDeleteAgent: vi.fn(),
  mockResolveWuPmoBatch: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
}));

vi.mock('../../../api/workunit', async () => {
  const actual = await vi.importActual('../../../api/workunit');
  return { ...actual, workunitApi: { list: mockWuList } };
});

vi.mock('../../../api/channel', () => ({
  channelApi: { deleteAgent: mockDeleteAgent },
}));

// PMO 归属解析打桩（wuPmo 单路解析的正确性由 WorkUnitDetailPage 链路既有覆盖承担）
vi.mock('../../../utils/wuPmo', () => ({
  resolveWuPmoBatch: mockResolveWuPmoBatch,
}));

import { DeleteRoleDialog } from '../DeleteRoleDialog';

const role = { id: 'p1', name: 'dev-agent' };

const wu = (id: string, scope: string, status: string) => ({
  id, scope, type: 'DEV', status, metadata: null, reqId: null,
});

function mockInFlight(
  items: Array<{ id: string; scope: string; status: string }>,
  pmoMap: Record<string, { id: string; pmoNumber: string; title: string } | null> = {},
) {
  const wus = items.map((t) => wu(t.id, t.scope, t.status));
  mockWuList.mockResolvedValue({ data: { data: wus, pagination: { total: wus.length } } });
  mockResolveWuPmoBatch.mockResolvedValue(new Map(Object.entries(pmoMap)));
}

describe('DeleteRoleDialog（#630 决策 5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteAgent.mockResolvedValue({});
  });

  it('打开即按 roleId 查在途清单（GET /workunits?assigneeId=<roleId>）', async () => {
    mockInFlight([]);
    render(<DeleteRoleDialog open profile={role} onClose={() => {}} onDeleted={() => {}} />);
    await waitFor(() => expect(mockWuList).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: 'p1' })));
  });

  it('在途任务列表：标题 + 状态词 + PMO 项目名，点击跳任务详情；终态（done）不进清单', async () => {
    mockInFlight(
      [
        { id: 'wu-1', scope: '实现登录接口', status: 'active' },
        { id: 'wu-2', scope: '已完成的历史任务', status: 'done' },
      ],
      { 'wu-1': { id: 'pmo1', pmoNumber: 'PMO-7', title: '用户系统' } },
    );
    render(<DeleteRoleDialog open profile={role} onClose={() => {}} onDeleted={() => {}} />);

    const link = (await screen.findByText('实现登录接口')).closest('a');
    expect(link?.getAttribute('href')).toBe('/workunits/wu-1');
    // 状态词走 WU_STATUS_LABELS 正词
    expect(screen.getByText('进行中')).toBeDefined();
    expect(screen.getByText('PMO-7 · 用户系统')).toBeDefined();
    // 终态排除
    expect(screen.queryByText('已完成的历史任务')).toBeNull();
    // 有在途 → 警告
    expect(screen.getByText(/这些任务会中断，等待系统自动回收/)).toBeDefined();
  });

  it('无归属在途任务显示「未归属」', async () => {
    mockInFlight([{ id: 'wu-3', scope: '杂务补丁', status: 'unassigned' }], { 'wu-3': null });
    render(<DeleteRoleDialog open profile={role} onClose={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText('杂务补丁')).toBeDefined();
    expect(screen.getByText('未归属')).toBeDefined();
  });

  it('无在途任务 → 明确空态文案，无警告', async () => {
    mockInFlight([]);
    render(<DeleteRoleDialog open profile={role} onClose={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText(/没有在途任务/)).toBeDefined();
    expect(screen.queryByText(/这些任务会中断/)).toBeNull();
  });

  it('确认删除 → deleteAgent(roleId) + onDeleted + 关窗', async () => {
    mockInFlight([]);
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    render(<DeleteRoleDialog open profile={role} onClose={onClose} onDeleted={onDeleted} />);
    await screen.findByText(/没有在途任务/);

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mockDeleteAgent).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('有在途任务仍允许删除（确认键可用）', async () => {
    mockInFlight([{ id: 'wu-1', scope: '实现登录接口', status: 'active' }], { 'wu-1': null });
    render(<DeleteRoleDialog open profile={role} onClose={() => {}} onDeleted={() => {}} />);
    await screen.findByText('实现登录接口');
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mockDeleteAgent).toHaveBeenCalledWith('p1'));
  });

  it('删除失败 → 内联报错留窗', async () => {
    mockInFlight([]);
    mockDeleteAgent.mockRejectedValue(new Error('db gone'));
    const onClose = vi.fn();
    render(<DeleteRoleDialog open profile={role} onClose={onClose} onDeleted={() => {}} />);
    await screen.findByText(/没有在途任务/);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(await screen.findByText(/db gone/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('在途清单拉取失败 → 错误上屏，确认键禁用（不清单盲删）', async () => {
    mockWuList.mockRejectedValue(new Error('network down'));
    render(<DeleteRoleDialog open profile={role} onClose={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText(/network down/)).toBeDefined();
    expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
  });

  it('open=false 不渲染、不拉取', () => {
    render(<DeleteRoleDialog open={false} profile={role} onClose={() => {}} onDeleted={() => {}} />);
    expect(screen.queryByText(/删除角色/)).toBeNull();
    expect(mockWuList).not.toHaveBeenCalled();
  });
});
