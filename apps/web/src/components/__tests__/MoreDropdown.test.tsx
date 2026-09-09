// header「更多」下拉：收纳 sidebar 四主项之外的入口（知识库/阅览室/监控/审计日志/设置；PMO 是主项不重复）
// #468 徽标投影化：计数徽标 = notificationStore.unreadCount（行动中心未读口径，归零可达），
// 原 monitoringApi 24h 告警 + 提案待审计数（loadAttentionCount）已删；展开下拉时 load() 刷新。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../api', () => ({ api: mockApi }));

import { MoreDropdown } from '../MoreDropdown';
import { useNotificationStore } from '../../stores/notificationStore';

const renderDropdown = () =>
  render(
    <MemoryRouter initialEntries={['/channels']}>
      <MoreDropdown />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
  mockApi.get.mockResolvedValue({ data: { stateItems: [], notifications: [], unreadCount: 0 } });
});

describe('MoreDropdown — header 更多菜单', () => {
  it('默认折叠：菜单项不可达', () => {
    renderDropdown();
    for (const label of ['知识库', '阅览室', '监控', '审计日志', '设置']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull();
    }
  });

  it('展开后全部菜单项可达且 href 正确（不含 sidebar 主项 PMO）', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const expected: Array<[string, string]> = [
      ['知识库', '/knowledge'],
      ['阅览室', '/library'],
      ['监控', '/monitoring'],
      ['审计日志', '/audit-logs'],
      ['设置', '/settings'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: new RegExp(label) });
      expect(link.getAttribute('href')).toBe(href);
    }
    expect(screen.queryByRole('link', { name: /PMO/ })).toBeNull();
  });

  it('点击菜单项后下拉收起', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('link', { name: /知识库/ }));
    expect(screen.queryByRole('link', { name: /阅览室/ })).toBeNull();
  });
});

describe('MoreDropdown — 徽标 = 行动中心 unreadCount（#468 投影化）', () => {
  it('unreadCount 5 → 按钮挂计数徽标 5', () => {
    useNotificationStore.setState({ unreadCount: 5 });
    renderDropdown();
    const badge = screen.getByTitle('有未读通知');
    expect(badge.textContent).toBe('5');
  });

  it('unreadCount > 99 → 截断显示 99+', () => {
    useNotificationStore.setState({ unreadCount: 120 });
    renderDropdown();
    expect(screen.getByTitle('有未读通知').textContent).toBe('99+');
  });

  it('unreadCount 0 → 不挂徽标（未读口径归零可达）', () => {
    renderDropdown();
    expect(screen.queryByTitle('有未读通知')).toBeNull();
  });

  it('展开下拉时 load() 刷新行动中心（GET /action-center）', async () => {
    renderDropdown();
    expect(mockApi.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/action-center'));
  });

  it('load 失败不炸：展开交互不受影响', async () => {
    mockApi.get.mockRejectedValue(new Error('network'));
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/action-center'));
    expect(screen.getByRole('link', { name: /监控/ })).toBeDefined();
  });
});
