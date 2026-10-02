// ChannelTopbar — P3-b 自 ChannelDetailPage 切出的顶栏装配：
// 频道名（formatChannelName + id 短显回退）/ 类型标识三态 / 三动作位（PMO chip、待办 chip、⋯ 菜单）挂载
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { formatChannelName } from '@dommaker/studio-shared/web';

// 三动作位各自有独立测试，保留接口隔离内部 store/API 依赖
vi.mock('../ChannelCurrentPmoChip', () => ({
  ChannelCurrentPmoChip: ({ channelId }: { channelId: string }) => (
    <span data-testid="pmo-chip" data-channel={channelId} />
  ),
}));
vi.mock('../ChannelNeedInputChip', () => ({
  ChannelNeedInputChip: ({ items, onLocate }: { items: Array<{ wuId: string }>; onLocate: (wuId: string) => void }) => (
    <button data-testid="need-input-chip" data-count={items.length} onClick={() => onLocate(items[0]?.wuId ?? '')} />
  ),
}));
vi.mock('../ChannelTopbarMenu', () => ({
  ChannelTopbarMenu: ({ defaultPath, onOpenActivity }: { defaultPath?: string | null; onOpenActivity: () => void }) => (
    <button data-testid="topbar-menu" data-path={defaultPath ?? ''} onClick={onOpenActivity} />
  ),
}));

import { ChannelTopbar } from '../ChannelTopbar';

const renderTopbar = (overrides: Partial<Parameters<typeof ChannelTopbar>[0]> = {}) => {
  const props = {
    channelId: 'ch-1234567890',
    channel: { name: '#研发', type: 'rnd', defaultPath: '/repo/a' },
    waitingWus: [{ wuId: 'wu-1' }],
    onLocateWaiting: vi.fn(),
    onOpenActivity: vi.fn(),
    ...overrides,
  };
  render(<ChannelTopbar {...props} />);
  return props;
};

describe('ChannelTopbar — P3-b 顶栏装配', () => {
  it('频道名经 formatChannelName 渲染（数据自带 # 不盲拼）；类型标识 rnd → 研发频道', () => {
    renderTopbar();
    expect(screen.getByText('#研发')).toBeTruthy();
    expect(screen.getByText('研发频道')).toBeTruthy();
  });

  it('类型标识：decision → 决策频道；其余 → 系统频道', () => {
    const { unmount } = render(<ChannelTopbar channelId="c1" channel={{ name: '#决策', type: 'decision' }} waitingWus={[]} onLocateWaiting={vi.fn()} onOpenActivity={vi.fn()} />);
    expect(screen.getByText('决策频道')).toBeTruthy();
    unmount();
    render(<ChannelTopbar channelId="c2" channel={{ name: '#系统', type: 'system' }} waitingWus={[]} onLocateWaiting={vi.fn()} onOpenActivity={vi.fn()} />);
    expect(screen.getByText('系统频道')).toBeTruthy();
  });

  it('channel 未拉到（null）：名称回退 id 短显前 8 位', () => {
    renderTopbar({ channel: null });
    expect(screen.getByText(formatChannelName('ch-12345'))).toBeTruthy();
    expect(screen.getByText('系统频道')).toBeTruthy();
  });

  it('三动作位挂载：PMO chip 收 channelId / 待办 chip 收投影 / 菜单收 defaultPath', () => {
    renderTopbar();
    expect(screen.getByTestId('pmo-chip').getAttribute('data-channel')).toBe('ch-1234567890');
    expect(screen.getByTestId('need-input-chip').getAttribute('data-count')).toBe('1');
    expect(screen.getByTestId('topbar-menu').getAttribute('data-path')).toBe('/repo/a');
  });

  it('回调接线：待办定位上送 wuId；菜单入口触发 onOpenActivity', () => {
    const props = renderTopbar();
    fireEvent.click(screen.getByTestId('need-input-chip'));
    expect(props.onLocateWaiting).toHaveBeenCalledWith('wu-1');
    fireEvent.click(screen.getByTestId('topbar-menu'));
    expect(props.onOpenActivity).toHaveBeenCalledTimes(1);
  });
});
