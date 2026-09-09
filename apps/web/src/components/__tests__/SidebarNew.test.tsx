// #393 左侧菜单精简：4 主项（频道/PMO/WorkUnit/Agent）；
// 收纳项（知识库/阅览室/监控/设置/审计日志）已移至顶部 header「更多」下拉（MoreDropdown），本组件不再有「更多」组
// #395（spec §4.6）：<768 频道左栏并入本 sidebar（频道路由下渲染于主导航之下，选频道后收起 overlay）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
import { useNotificationStore } from '../../stores/notificationStore';
import { mockMatchMedia, uninstallMatchMedia } from '../../test/mockMatchMedia';

const renderSidebar = (initialPath = '/channels/ch-1') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>,
  );

describe('Sidebar — #393 菜单精简', () => {
  beforeEach(() => {
    // 模块单例 store 跨用例复位（#474：unreadCount>0 会挂「监控」临时主项，防泄漏进精简断言）
    useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
  });

  it('主项仅 4 个：频道 / PMO / 任务 / 角色', () => {
    renderSidebar();
    for (const label of ['频道', 'PMO', '任务', '角色']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }
    // 收纳项不在 sidebar（已移至 header「更多」下拉）
    for (const label of ['知识库', '阅览室', '监控', '设置', '审计日志']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull();
    }
    // 不再有「更多」展开按钮
    expect(screen.queryByRole('button', { name: /更多/ })).toBeNull();
  });

  // 批次A 项8：底部假「就绪」状态已删除（恒绿假状态，真实 SSE 连接态如需另开入口接入）
  it('不渲染底部假「就绪」状态块', () => {
    renderSidebar();
    expect(screen.queryByText('就绪')).toBeNull();
  });

  // #474 图标策略定稿：全去 emoji——主导航图标为 stroke SVG 组件，文本无 emoji
  it('#474 主导航去 emoji：图标为 SVG 组件，链接文本无 emoji', () => {
    renderSidebar();
    for (const label of ['频道', 'PMO', '任务', '角色']) {
      const link = screen.getByRole('link', { name: new RegExp(label) });
      expect(link.querySelector('svg')).toBeTruthy();
      expect(link.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u);
    }
  });
});

describe('Sidebar — #474 监控入口：有待处理时升主导航临时项', () => {
  afterEach(() => {
    useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
  });

  it('行动中心 unreadCount > 0 → 主导航出现「监控」临时项（带计数徽标）', () => {
    useNotificationStore.setState({ unreadCount: 3 });
    renderSidebar();
    const link = screen.getByRole('link', { name: /监控/ });
    expect(link.getAttribute('href')).toBe('/monitoring');
    expect(link.querySelector('svg')).toBeTruthy();
    expect(screen.getByTitle('有待处理事项').textContent).toBe('3');
  });

  it('unreadCount = 0 → 监控留在「更多」下拉，不占主导航', () => {
    renderSidebar();
    expect(screen.queryByRole('link', { name: /监控/ })).toBeNull();
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
