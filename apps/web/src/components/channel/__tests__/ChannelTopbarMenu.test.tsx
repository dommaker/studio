// ChannelTopbarMenu — E1（2026-09 页面重设计）：顶栏 ⋯ 菜单
// 覆盖：默认收起 / 点击展开四个收纳位 / 频道动态入口回调并收菜单 / 点外部收起 /
// 默认工程 Select 的 portal 面板（.select-panel）点击不收菜单 / 成员管理触发器换菜单行形态
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// 三个收纳组件保留接口、隔离内部 API 依赖（成员/PMO/默认工程各自有独立测试）
vi.mock('../ChannelCurrentPmoChip', () => ({
  ChannelCurrentPmoChip: ({ channelId }: { channelId: string }) => <div data-testid="current-pmo-chip" data-channel={channelId} />,
}));
vi.mock('../ChannelMemberManager', () => ({
  ChannelMemberManager: ({ triggerClassName }: { triggerClassName?: string }) => (
    <button type="button" className={triggerClassName} data-testid="member-manager">成员</button>
  ),
}));
vi.mock('../ChannelDefaultProjectSelect', () => ({
  ChannelDefaultProjectSelect: ({ defaultPath }: { defaultPath?: string | null }) => (
    <div data-testid="default-project-select" data-path={defaultPath ?? ''} />
  ),
}));

import { ChannelTopbarMenu } from '../ChannelTopbarMenu';

const renderMenu = (onOpenActivity = vi.fn()) => {
  render(<ChannelTopbarMenu channelId="ch-1" defaultPath="/repo/a" onOpenActivity={onOpenActivity} />);
  return onOpenActivity;
};

describe('ChannelTopbarMenu — E1 顶栏 ⋯ 菜单', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    // 清理 .select-panel 豁免用例挂到 body 的假面板
    document.body.querySelectorAll('.select-panel').forEach(el => el.remove());
  });

  it('默认收起；点 ⋯ 展开四个收纳位（频道动态/PMO/成员/默认工程）', () => {
    renderMenu();
    expect(screen.queryByTestId('current-pmo-chip')).toBeNull();
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(screen.getByRole('button', { name: '打开频道动态' })).toBeTruthy();
    expect(screen.getByTestId('current-pmo-chip').getAttribute('data-channel')).toBe('ch-1');
    expect(screen.getByTestId('member-manager')).toBeTruthy();
    expect(screen.getByTestId('default-project-select').getAttribute('data-path')).toBe('/repo/a');
  });

  it('成员管理触发器以菜单行形态渲染（triggerClassName 透传）', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(screen.getByTestId('member-manager').className).toBe('mc-topbar-menu-item');
  });

  it('点「频道动态」→ onOpenActivity 回调且菜单收起', () => {
    const onOpenActivity = renderMenu();
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByRole('button', { name: '打开频道动态' }));
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('current-pmo-chip')).toBeNull();
  });

  it('点组件外部收起菜单', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(screen.getByTestId('current-pmo-chip')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('current-pmo-chip')).toBeNull();
  });

  it('点 .select-panel（默认工程 Select 的 portal 面板）不收菜单', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('更多操作'));
    const panel = document.createElement('div');
    panel.className = 'select-panel';
    document.body.appendChild(panel);
    fireEvent.mouseDown(panel);
    expect(screen.getByTestId('current-pmo-chip')).toBeTruthy();
  });
});
