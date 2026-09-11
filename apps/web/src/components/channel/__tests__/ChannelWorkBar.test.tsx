// ChannelWorkBar — 频道工作条（合并 ChannelLiveBars #242/#322 与 ChannelStageBar #440/#447）：
// 渲染规则见 docs/plans/2026-09-channel-workbar.md。阶段语义 = deriveDisplayState 展示列
// （与 WU 详情页同口径，不发明第二套阶段模型）；live 数据源沿用自持有的 useChannelLiveExecutions。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

  it('无 currentWu 且无 active WU → 留「状态同步中」占位（#474：不再整条静默消失）', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByLabelText('频道工作条')).toBeTruthy();
    expect(screen.getByText('状态同步中…')).toBeTruthy();
    // 占位语义：无 stepper、无 live 列表
    expect(stationEls(container)).toHaveLength(0);
    expect(container.querySelector('.mc-workbar-livelist')).toBeNull();
  });

  // #488：占位三态区分——加载（端点未返回/失败/skew）/ 空闲（端点返回 currentWuId=null）/ 有 currentWu
  it('#488 空闲态：wuIdle=true 且无 currentWu 无 live → 空闲文案，不再显示「状态同步中」', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} wuIdle />);
    expect(screen.getByText('频道暂无进行中的工作')).toBeTruthy();
    expect(screen.queryByText('状态同步中…')).toBeNull();
    expect(stationEls(container)).toHaveLength(0);
    expect(container.querySelector('.mc-workbar-livelist')).toBeNull();
  });

  it('#488 加载态（默认）：不传 wuIdle → 保持「状态同步中…」（端点未返回/请求失败不误显空闲）', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} />);
    expect(screen.getByText('状态同步中…')).toBeTruthy();
    expect(screen.queryByText('频道暂无进行中的工作')).toBeNull();
  });

  it('#488 有 currentWu：wuIdle 不影响——仍渲染阶段条主区，无占位', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={() => {}} wuIdle />);
    expect(stationEls(container)).toHaveLength(4);
    expect(screen.queryByText('频道暂无进行中的工作')).toBeNull();
    expect(screen.queryByText('状态同步中…')).toBeNull();
  });

  it('#488 空闲 + 有 live → 渲染 live 列表而非空闲占位', () => {
    mockUseChannelLiveExecutions.mockReturnValue([{ workUnitId: 'WU-1018', step: 1 }]);
    render(<ChannelWorkBar channelId="ch-1" currentWu={null} onOpenWorkUnit={() => {}} wuIdle />);
    expect(screen.getByText(/WU-1018 正在执行/)).toBeTruthy();
    expect(screen.queryByText('频道暂无进行中的工作')).toBeNull();
    expect(screen.queryByText('状态同步中…')).toBeNull();
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

  // E1：workbar 内 stepper 站点可点（与 live 徽标统一入口）——点击任意站开 currentWu 抽屉
  it('stepper 站点可点：点击开 currentWu 抽屉', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const onOpenWorkUnit = vi.fn();
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={onOpenWorkUnit} />);
    const btns = container.querySelectorAll('button.wu-bstep-btn');
    expect(btns).toHaveLength(4);
    fireEvent.click(screen.getByText('待验收'));
    expect(onOpenWorkUnit).toHaveBeenCalledWith('WU-1');
  });

  // D-2 项6：currentWu 闸门态 → 工作条直挂共享 WuGateActions（写路径经 gate prop 注入）
  const gateHandlers = () => ({
    onReviewPassed: vi.fn().mockResolvedValue({}),
    onReviewRejected: vi.fn().mockResolvedValue({}),
    onConfirmPending: vi.fn().mockResolvedValue({}),
  });

  it('D-2 项6：pending currentWu + gate → 工作条渲染「确认并开放领取」，点击调 onConfirmPending', async () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const gate = gateHandlers();
    const { container } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'pending' })} onOpenWorkUnit={() => {}} gate={gate} />);
    const btn = screen.getByRole('button', { name: '确认并开放领取' });
    expect(btn.className).toContain('btn-sm');
    expect(container.querySelector('.mc-workbar-gate')).not.toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(gate.onConfirmPending).toHaveBeenCalledTimes(1));
    expect(gate.onReviewPassed).not.toHaveBeenCalled();
  });

  it('D-2 项6：in_review currentWu（task 类型）→ 渲染「通过验收/拒绝」，通过直调 onReviewPassed', async () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const gate = gateHandlers();
    render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'in_review' })} onOpenWorkUnit={() => {}} gate={gate} />);
    fireEvent.click(screen.getByRole('button', { name: '通过验收' }));
    await waitFor(() => expect(gate.onReviewPassed).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
  });

  it('D-2 项6：done 缺 l3 → 渲染「人工验收确认」；done 且 l3 齐 → 不渲染闸门区', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const metaNoL3 = JSON.stringify({
      attestations: { l2: { verdict: 'approved', by: 'rev', at: '2026-09-01T01:30:00Z', kind: 'agent-review' } },
    });
    const { unmount } = render(
      <ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'done', metadata: metaNoL3 })} onOpenWorkUnit={() => {}} gate={gateHandlers()} />,
    );
    expect(screen.getByRole('button', { name: '人工验收确认' })).toBeTruthy();
    unmount();

    const metaFull = JSON.stringify({
      attestations: {
        l2: { verdict: 'approved', by: 'rev', at: '2026-09-01T01:30:00Z', kind: 'agent-review' },
        l3: { verdict: 'approved', by: 'human', at: '2026-09-01T02:00:00Z', kind: 'human-accept' },
      },
    });
    const { container } = render(
      <ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'done', metadata: metaFull })} onOpenWorkUnit={() => {}} gate={gateHandlers()} />,
    );
    expect(container.querySelector('.mc-workbar-gate')).toBeNull();
  });

  it('D-2 项6：active currentWu（非闸门态）→ 不渲染闸门区；无 gate prop → 闸门态也不渲染', () => {
    mockUseChannelLiveExecutions.mockReturnValue([]);
    const { container, unmount } = render(
      <ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'active' })} onOpenWorkUnit={() => {}} gate={gateHandlers()} />,
    );
    expect(container.querySelector('.mc-workbar-gate')).toBeNull();
    unmount();

    const { container: c2 } = render(<ChannelWorkBar channelId="ch-1" currentWu={wu({ status: 'in_review' })} onOpenWorkUnit={() => {}} />);
    expect(c2.querySelector('.mc-workbar-gate')).toBeNull();
  });
});
