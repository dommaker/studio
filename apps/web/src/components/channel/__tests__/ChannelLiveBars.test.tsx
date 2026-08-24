// ChannelLiveBars（#322 live 执行状态下沉）：live 条组件自持有 useChannelLiveExecutions，
// 页面只传 channelId + onOpenWorkUnit。渲染/交互语义与 #242 原页面内 JSX 一致。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockUseChannelLiveExecutions } = vi.hoisted(() => ({
  mockUseChannelLiveExecutions: vi.fn(),
}));

vi.mock('../../../hooks/useChannelLiveExecutions', () => ({
  useChannelLiveExecutions: (channelId: string | null) => mockUseChannelLiveExecutions(channelId),
}));

import { ChannelLiveBars } from '../ChannelLiveBars';

describe('ChannelLiveBars — #322 live 执行状态下沉', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('以 channelId 自持有 useChannelLiveExecutions', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    render(<ChannelLiveBars channelId="ch-1" onOpenWorkUnit={() => {}} />);
    expect(mockUseChannelLiveExecutions).toHaveBeenCalledWith('ch-1');
  });

  it('无执行中 WU → 不渲染', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelLiveBars channelId="ch-1" onOpenWorkUnit={() => {}} />);
    expect(container.querySelector('.mc-livebars')).toBeNull();
  });

  it('执行中 WU → 状态条（WU 短 id + 步号 + action）；点击开抽屉', () => {
    mockUseChannelLiveExecutions.mockReturnValue([
      { workUnitId: 'WU-1018', step: 3, action: 'progress' },
      { workUnitId: 'WU-2020' },
    ]);
    const onOpenWorkUnit = vi.fn();
    render(<ChannelLiveBars channelId="ch-1" onOpenWorkUnit={onOpenWorkUnit} />);
    expect(screen.getByText(/WU-1018 正在执行 · 第 3 步 · progress/)).toBeTruthy();
    // 无步号/动作时不渲染该段
    expect(screen.getByText(/WU-2020 正在执行/)).toBeTruthy();
    expect(screen.queryByText(/WU-2020 正在执行 ·/)).toBeNull();
    fireEvent.click(screen.getByText(/WU-1018 正在执行/));
    expect(onOpenWorkUnit).toHaveBeenCalledWith('WU-1018');
  });
});
