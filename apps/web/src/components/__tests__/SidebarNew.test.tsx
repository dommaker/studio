// #393 左侧菜单精简：4 主项（频道/PMO/WorkUnit/Agent）；
// 收纳项（知识库/阅览室/监控/设置/审计日志）已移至顶部 header「更多」下拉（MoreDropdown），本组件不再有「更多」组
// #395（spec §4.6）：<768 频道左栏并入本 sidebar（频道路由下渲染于主导航之下，选频道后收起 overlay）
import { describe, it, expect, vi, afterEach } from 'vitest';
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
import { mockMatchMedia, uninstallMatchMedia } from '../../test/mockMatchMedia';

const renderSidebar = (initialPath = '/channels/ch-1') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>,
  );

describe('Sidebar — #393 菜单精简', () => {
  it('主项仅 4 个：频道 / PMO / 任务 / Agent', () => {
    renderSidebar();
    for (const label of ['频道', 'PMO', '任务', 'Agent']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }
    // 收纳项不在 sidebar（已移至 header「更多」下拉）
    for (const label of ['知识库', '阅览室', '监控', '设置', '审计日志']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull();
    }
    // 不再有「更多」展开按钮
    expect(screen.queryByRole('button', { name: /更多/ })).toBeNull();
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
