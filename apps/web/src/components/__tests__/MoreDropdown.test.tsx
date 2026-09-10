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

  // #474 图标策略定稿：全去 emoji——菜单项与触发器图标为 SVG 组件，文本无 emoji
  it('#474 菜单去 emoji：各项图标为 SVG，文本无 emoji', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
    for (const label of ['知识库', '阅览室', '监控', '审计日志', '设置']) {
      const link = screen.getByRole('link', { name: new RegExp(label) });
      expect(link.querySelector('svg')).toBeTruthy();
      expect(link.textContent).not.toMatch(emojiRe);
    }
    const trigger = screen.getByRole('button', { name: /更多/ });
    expect(trigger.querySelector('svg')).toBeTruthy();
    expect(trigger.textContent).not.toMatch(emojiRe);
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

describe('MoreDropdown — 「搜索 ⌘K」入口（批次 D-2 项 8）', () => {
  it('传 onOpenSearch：渲染搜索项，点击触发并收起下拉', () => {
    const onOpenSearch = vi.fn();
    render(
      <MemoryRouter initialEntries={['/channels']}>
        <MoreDropdown onOpenSearch={onOpenSearch} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const item = screen.getByRole('button', { name: /搜索/ });
    expect(item.textContent).toContain('⌘K');
    fireEvent.click(item);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /知识库/ })).toBeNull();
  });

  it('不传 onOpenSearch：不渲染搜索项（旧调用方零影响）', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    expect(screen.queryByRole('button', { name: /搜索/ })).toBeNull();
  });
});
