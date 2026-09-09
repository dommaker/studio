// ChannelWorkBar — 频道工作条（合并 ChannelLiveBars #242/#322 与 ChannelStageBar #440/#447）：
// 渲染规则见 docs/plans/2026-09-channel-workbar.md。阶段语义 = deriveDisplayState 展示列
// （与 WU 详情页同口径，不发明第二套阶段模型）；live 数据源沿用自持有的 useChannelLiveExecutions。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockUseChannelLiveExecutions } = vi.hoisted(() => ({
  mockUseChannelLiveExecutions: vi.fn(),
}));

vi.mock('../../../hooks/useChannelLiveExecutions', () => ({
  useChannelLiveExecutions: (channelId: string | null) => mockUseChannelLiveExecutions(channelId),
}));

import { ChannelWorkBar } from '../ChannelWorkBar';
import type { WorkUnit } from '../../../api/workunit';

const wu = (over: Partial<WorkUnit>): WorkUnit => ({
  id: 'WU-1', parentId: null, dependsOn: '', type: 'task', scope: 's',
  assigneeId: null, status: 'active', failureType: null, retryCount: 0,
  timeoutAt: null, channelId: 'ch-1', metadata: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T01:00:00Z',
  claimedAt: '2026-09-01T00:30:00Z', completedAt: null,
  ...over,
});

const stationEls = (container: HTMLElement) => [...container.querySelectorAll('.wu-bstep')];

describe('ChannelWorkBar — 频道工作条', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('以 channelId 自持有 useChannelLiveExecutions', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} />);
    expect(mockUseChannelLiveExecutions).toHaveBeenCalledWith('ch-1');
  });

  it('无 currentWu 且无 active WU → 不渲染', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('无 currentWu 有 active → 仅 live 列表（WU 短 id + 步号 + action）；点击开抽屉', () => {
    mockUseChannelLiveExecutions.mockReturnValue([
      { workUnitId: 'WU-1018', step: 3, action: 'progress' },
      { workUnitId: 'WU-2020' },
    ]);
    const onOpenWorkUnit = vi.fn();
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={onOpenWorkUnit} />);
    expect(screen.getByText(/WU-1018 正在执行 · 第 3 步 · progress/)).toBeTruthy();
    // 无步号/动作时不渲染该段
    expect(screen.getByText(/WU-2020 正在执行/)).toBeTruthy();
    expect(screen.queryByText(/WU-2020 正在执行 ·/)).toBeNull();
    // 主区 stepper 不渲染
    expect(stationEls(container)).toHaveLength(0);
    fireEvent.click(screen.getByText(/WU-1018 正在执行/));
    expect(onOpenWorkUnit).toHaveBeenCalledWith('WU-1018');
  });

  it('fail-closed：currentWu 为 null（currentWuId 未命中）→ 主区不渲染，只显示 live 部分', () => {
    mockUseChannelLiveExecutions.mockReturnValue([{ workUnitId: 'WU-1018', step: 1 }]);
    render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} />);
    expect(screen.queryByLabelText('工单阶段')).toBeNull();
    expect(screen.getByText(/WU-1018 正在执行/)).toBeTruthy();
  });

  it('有 currentWu 无 active → 仅 stepper 主区（无实况叠加、无溢出 chip、无 live 列表）', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={() => {}} />);
    expect(stationEls(container)).toHaveLength(4);
    expect(container.querySelector('.mc-workbar-selflive')).toBeNull();
    expect(container.querySelector('.mc-workbar-chip')).toBeNull();
    expect(container.querySelector('.mc-workbar-livelist')).toBeNull();
  });

  it('有 currentWu 且自身 active（仅自身）→ stepper + 当前站旁叠加「第 N 步 · 动作」，无溢出 chip；点击叠加开自身抽屉', () => {
    mockUseChannelLiveExecutions.mockReturnValue([{ workUnitId: 'WU-1', step: 3, action: '写代码' }]);
    const onOpenWorkUnit = vi.fn();
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={onOpenWorkUnit} />);
    expect(stationEls(container)).toHaveLength(4);
    const overlay = container.querySelector('.mc-workbar-selflive')!;
    expect(overlay.textContent).toContain('第 3 步 · 写代码');
    expect(container.querySelector('.mc-workbar-chip')).toBeNull();
    fireEvent.click(overlay);
    expect(onOpenWorkUnit).toHaveBeenCalledWith('WU-1');
  });

  it('有 currentWu + 其他 active → stepper +「+N 进行中」chip，点击展开小列表，条目点击开对应抽屉', () => {
    mockUseChannelLiveExecutions.mockReturnValue([
      { workUnitId: 'WU-1018', step: 1 },
      { workUnitId: 'WU-2020' },
    ]);
    const onOpenWorkUnit = vi.fn();
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'in_review' })} onOpenWorkUnit={onOpenWorkUnit} />);
    expect(stationEls(container)).toHaveLength(4);
    // 其他 active 未展开前不显示条目
    expect(screen.queryByText(/WU-1018 正在执行/)).toBeNull();
    const chip = screen.getByText(/\+2 进行中/);
    fireEvent.click(chip);
    const item = screen.getByText(/WU-1018 正在执行/);
    fireEvent.click(item);
    expect(onOpenWorkUnit).toHaveBeenCalledWith('WU-1018');
  });

  it('有 currentWu 自身 active + 其他 active → 叠加自身实况 +「+1 进行中」chip（溢出只计其他）', () => {
    mockUseChannelLiveExecutions.mockReturnValue([
      { workUnitId: 'WU-1', step: 2, action: '跑测试' },
      { workUnitId: 'WU-1018' },
    ]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={() => {}} />);
    expect(container.querySelector('.mc-workbar-selflive')!.textContent).toContain('第 2 步 · 跑测试');
    expect(screen.getByText(/\+1 进行中/)).toBeTruthy();
    expect(screen.queryByText(/\+2 进行中/)).toBeNull();
  });

  it('active WU → 四站渲染，当前站 = 进行中，前站 done、后站 upcoming', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={() => {}} />);
    const steps = stationEls(container);
    expect(steps).toHaveLength(4);
    expect(steps.map(el => el.querySelector('.wu-st-label')!.textContent))
      .toEqual(['待领取', '进行中', '待验收', '完成']);
    expect(steps[0].className).toContain('wu-st-done');
    expect(steps[1].className).toContain('wu-st-current');
    expect(steps[2].className).toContain('wu-st-upcoming');
    expect(steps[3].className).toContain('wu-st-upcoming');
  });

  it('in_review WU → 当前站 = 待验收（三态可区分）', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'in_review' })} onOpenWorkUnit={() => {}} />);
    const steps = stationEls(container);
    expect(steps[2].className).toContain('wu-st-current');
    expect(steps[0].className).toContain('wu-st-done');
    expect(steps[3].className).toContain('wu-st-upcoming');
  });

  it('done WU（无证据 legacy）→ 四站全 done', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'done', completedAt: '2026-09-01T02:00:00Z' })} onOpenWorkUnit={() => {}} />);
    const steps = stationEls(container);
    expect(steps.every(el => el.className.includes('wu-st-done'))).toBe(true);
  });

  it('阶段语义与 deriveDisplayState 同口径：done 缺 l3 → 当前站回待验收', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const metadata = JSON.stringify({
      attestations: { l2: { verdict: 'approved', by: 'rev', at: '2026-09-01T01:30:00Z', kind: 'agent-review' } },
    });
    render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'done', metadata })} onOpenWorkUnit={() => {}} />);
    // 展示列回 in_review → 「待验收」为当前站
    const bar = screen.getByLabelText('工单阶段');
    const steps = [...bar.querySelectorAll('.wu-bstep')];
    expect(steps[2].className).toContain('wu-st-current');
    expect(steps[3].className).toContain('wu-st-upcoming');
  });
});
