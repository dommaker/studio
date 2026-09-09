// header「更多」下拉：收纳 sidebar 四主项之外的入口（知识库/阅览室/监控/审计日志/设置；PMO 是主项不重复）
// E4/B-8：有待处理告警/提案时按钮挂计数徽标（数据 = overview.alerts.last24h + flywheel.proposalsPendingReview）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGetOverview, mockGetFlywheel } = vi.hoisted(() => ({
  mockGetOverview: vi.fn(),
  mockGetFlywheel: vi.fn(),
}));
vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getOverview: mockGetOverview, getFlywheel: mockGetFlywheel },
}));

import { MoreDropdown } from '../MoreDropdown';

const renderDropdown = () =>
  render(
    <MemoryRouter initialEntries={['/channels']}>
      <MoreDropdown />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOverview.mockResolvedValue({ data: { alerts: { last24h: 0 } } });
  mockGetFlywheel.mockResolvedValue({ data: { proposalsPendingReview: 0 } });
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

describe('MoreDropdown — 监控待处理计数徽标（E4/B-8）', () => {
  it('告警 2 + 提案待审 3 → 按钮挂计数徽标 5', async () => {
    mockGetOverview.mockResolvedValue({ data: { alerts: { last24h: 2 } } });
    mockGetFlywheel.mockResolvedValue({ data: { proposalsPendingReview: 3 } });
    renderDropdown();
    const badge = await screen.findByTitle('监控有待处理事项');
    expect(badge.textContent).toBe('5');
  });

  it('待处理为 0 → 不挂徽标', async () => {
    renderDropdown();
    await waitFor(() => expect(mockGetOverview).toHaveBeenCalled());
    expect(screen.queryByTitle('监控有待处理事项')).toBeNull();
  });

  it('监控接口 403/失败（非 Admin）→ 徽标隐藏，不炸', async () => {
    mockGetOverview.mockRejectedValue(new Error('403'));
    mockGetFlywheel.mockRejectedValue(new Error('403'));
    renderDropdown();
    // 展开交互不受取数失败影响
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    expect(screen.getByRole('link', { name: /监控/ })).toBeDefined();
    expect(screen.queryByTitle('监控有待处理事项')).toBeNull();
  });

  it('展开下拉时重拉计数（服务端 60s 缓存兜底成本）', async () => {
    renderDropdown();
    await waitFor(() => expect(mockGetOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    await waitFor(() => expect(mockGetOverview).toHaveBeenCalledTimes(2));
  });
});
