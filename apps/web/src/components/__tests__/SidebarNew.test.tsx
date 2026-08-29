// #393 左侧菜单精简：4 主项（频道/PMO/WorkUnit/Agent）+「更多」收纳 5 项
// #395（spec §4.6）：<768 频道左栏并入本 sidebar（频道路由下渲染于主导航之下，选频道后收起 overlay）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';

// #395：隔离 ChannelRail 内部 API 依赖，只保留接口（activeChannelId / onNavigate）
const { mockChannelRailSpy } = vi.hoisted(() => ({ mockChannelRailSpy: vi.fn() }));
vi.mock('../channel/ChannelRail', () => ({
  ChannelRail: (props: { activeChannelId?: string; onNavigate?: () => void }) => {
    mockChannelRailSpy(props);
    return (
      <div data-testid="channel-rail" data-active={props.activeChannelId}>
        <button data-testid="rail-pick" onClick={() => props.onNavigate?.()}>选频道</button>
      </div>
    );
  },
}));

import { Sidebar } from '../SidebarNew';
import { mockMatchMedia, uninstallMatchMedia } from '../../test/mockMatchMedia';

const renderSidebar = (initialPath = '/channels/ch-1') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>,
  );

describe('Sidebar — #393 菜单精简', () => {
  it('主项仅 4 个：频道 / PMO / WorkUnit / Agent', () => {
    renderSidebar();
    for (const label of ['频道', 'PMO', 'WorkUnit', 'Agent']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }
    // 收纳项折叠态不可达
    for (const label of ['知识库', '阅览室', '监控', '设置', '审计日志']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull();
    }
  });

  it('展开「更多」后 5 个收纳项全部可达', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const expected: Array<[string, string]> = [
      ['知识库', '/knowledge'],
      ['阅览室', '/library'],
      ['监控', '/monitoring'],
      ['设置', '/settings'],
      ['审计日志', '/audit-logs'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: new RegExp(label) });
      expect(link.getAttribute('href')).toBe(href);
    }
  });

  it('当前路由落在收纳项时「更多」呈激活态', () => {
    renderSidebar('/monitoring');
    const moreBtn = screen.getByRole('button', { name: /更多/ });
    // 激活态与主项一致：accent 色文字
    expect(moreBtn.style.color).toBe('var(--accent-primary)');
  });

  it('当前路由不在收纳项时「更多」非激活态', () => {
    renderSidebar('/pmo');
    const moreBtn = screen.getByRole('button', { name: /更多/ });
    expect(moreBtn.style.color).not.toBe('var(--accent-primary)');
  });

  it('站内跳转进收纳路由：「更多」自动展开（sidebar 常驻不卸载）', () => {
    render(
      <MemoryRouter initialEntries={['/channels/ch-1']}>
        <Sidebar />
        <Link to="/settings">跳设置</Link>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /知识库/ })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '跳设置' }));
    expect(screen.getByRole('link', { name: /知识库/ })).toBeTruthy();
  });
});

describe('Sidebar — #395 窄屏并入频道左栏', () => {
  afterEach(() => uninstallMatchMedia());

  it('<768 + 频道路由：sidebar 内渲染 ChannelRail（activeChannelId 取自路由）', () => {
    mockMatchMedia(700);
    renderSidebar('/channels/ch-1');
    const rail = screen.getByTestId('channel-rail');
    expect(rail.dataset.active).toBe('ch-1');
  });

  it('<768 + 非频道路由：不渲染 ChannelRail', () => {
    mockMatchMedia(700);
    renderSidebar('/pmo');
    expect(screen.queryByTestId('channel-rail')).toBeNull();
  });

  it('≥768：不渲染 ChannelRail（左栏由频道工作区内联挂载）', () => {
    mockMatchMedia(900);
    renderSidebar('/channels/ch-1');
    expect(screen.queryByTestId('channel-rail')).toBeNull();
  });

  it('matchMedia 缺失（jsdom 默认）回落宽屏：不渲染 ChannelRail', () => {
    renderSidebar('/channels/ch-1');
    expect(screen.queryByTestId('channel-rail')).toBeNull();
  });

  it('窄屏 overlay 态选频道后触发 onClose（收起 sidebar overlay）', () => {
    mockMatchMedia(700);
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/channels/ch-1']}>
        <Sidebar isOpen onClose={onClose} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('rail-pick'));
    expect(onClose).toHaveBeenCalled();
  });
});
