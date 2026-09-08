// #394 ChannelActivityRail — 频道动态右栏：REQ 链路卡（四站 stepper）+ 混合交互（REQ/WU 抽屉、PMO/Agent ↗ 跳页）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockGetChain, mockGetCurrentPmo, mockProjectGet, mockResolveAssignee, mockNavigate } = vi.hoisted(() => ({
  mockGetChain: vi.fn(),
  mockGetCurrentPmo: vi.fn(),
  mockProjectGet: vi.fn(),
  mockResolveAssignee: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('../../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));
vi.mock('../../../api/channel', () => ({
  channelApi: { getCurrentPmo: mockGetCurrentPmo },
}));
vi.mock('../../../api', () => ({
  projectApi: { get: mockProjectGet },
}));
vi.mock('../../../hooks/useAssigneeDisplay', () => ({
  resolveAssignee: mockResolveAssignee,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { ChannelActivityRail } from '../ChannelActivityRail';
import { useChannelDataStore } from '../../../stores/channelDataStore';
import { useRequirementChainStore } from '../../../stores/requirementChainStore';
import type { Requirement } from '../../../api/requirements';
import type { ChannelActivityItem } from '../activityRail';

function req(id: string, over: Partial<Requirement> = {}): Requirement {
  return {
    id, seq: 1, title: `标题${id}`, status: 'in-progress',
    createdAt: '2026-08-01T00:00:00Z', createdBy: 'human', ...over,
  };
}

function chain(projectId: string | null, workunits: { id: string; status: string; assigneeId?: string | null }[]) {
  return {
    data: {
      data: {
        requirement: { projectId },
        workunits: workunits.map(w => ({ id: w.id, title: `任务${w.id}`, status: w.status, assigneeId: w.assigneeId ?? null })),
      },
    },
  };
}

function renderRail(over: Partial<Parameters<typeof ChannelActivityRail>[0]> = {}) {
  const props = {
    channelId: 'ch1',
    reqs: [] as Requirement[],
    messageItems: [] as ChannelActivityItem[],
    waitingWus: [],
    onOpenWu: vi.fn(),
    onOpenReq: vi.fn(),
    ...over,
  };
  render(<ChannelActivityRail {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  // #403：rail 的 current-pmo 走 channelDataStore——每测重置（数据 + 模块级 TTL 簿记）
  useChannelDataStore.getState().__resetForTests();
  // #412：rail 的 chain 走 requirementChainStore——每测重置（模块级 TTL 簿记跨测残留）
  useRequirementChainStore.getState().__resetForTests();
  mockGetCurrentPmo.mockResolvedValue({ data: { data: null } });
  mockResolveAssignee.mockResolvedValue(null);
});

describe('ChannelActivityRail — REQ 链路卡与 stepper', () => {
  it('每 REQ 一卡：卡头 id/标题/状态 + 四站 stepper（WU 站真实计数）', async () => {
    mockGetChain.mockResolvedValue(chain(null, [{ id: 'wu-a', status: 'done' }, { id: 'wu-b', status: 'active' }]));
    renderRail({ reqs: [req('REQ-0001')] });

    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('标题REQ-0001')).toBeTruthy();
    expect(within(card).getByText('讨论')).toBeTruthy();
    expect(within(card).getByText('REQ')).toBeTruthy();
    expect(await within(card).findByText('WU 1/2')).toBeTruthy();
    expect(within(card).getByText('交付')).toBeTruthy();
    // 当前站 = WU（高亮 class），讨论/REQ 已达成，交付未到
    expect(within(card).getByText('WU 1/2').closest('.mc-act-step')!.className).toContain('mc-act-step-current');
    expect(within(card).getByText('讨论').closest('.mc-act-step')!.className).toContain('mc-act-step-done');
    expect(within(card).getByText('交付').closest('.mc-act-step')!.className).toContain('mc-act-step-upcoming');
  });

  it('卡头 / REQ 站点击 → onOpenReq；WU 站点击 → onOpenWu（在飞 WU）', async () => {
    mockGetChain.mockResolvedValue(chain(null, [{ id: 'wu-a', status: 'done' }, { id: 'wu-b', status: 'active' }]));
    const props = renderRail({ reqs: [req('REQ-0001')] });

    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    fireEvent.click(within(card).getByText('标题REQ-0001'));
    expect(props.onOpenReq).toHaveBeenCalledWith('REQ-0001');

    fireEvent.click(await within(card).findByText('WU 1/2'));
    expect(props.onOpenWu).toHaveBeenCalledWith('wu-b');

    fireEvent.click(within(card).getByText('REQ'));
    expect(props.onOpenReq).toHaveBeenCalledTimes(2);
  });

  it('chain 拉取失败 → 该卡仍渲染（stepper 退化无 WU），不炸', async () => {
    mockGetChain.mockRejectedValue(new Error('boom'));
    renderRail({ reqs: [req('REQ-0001')] });
    expect(await screen.findByText('WU 0/0')).toBeTruthy();
  });
});

describe('ChannelActivityRail — PMO badge 数据链兜底（§4.3）', () => {
  it('chain.requirement.projectId 优先：渲染 PMO 号·标题 ↗，点击跳项目页', async () => {
    mockGetChain.mockResolvedValue(chain('proj-1', []));
    mockProjectGet.mockResolvedValue({ data: { pmoNumber: 'PMO-7', title: '项目X' } });
    renderRail({ reqs: [req('REQ-0001')] });

    const badge = await screen.findByText(/PMO-7 · 项目X/);
    expect(badge.textContent).toContain('↗');
    fireEvent.click(badge);
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-1');
  });

  it('REQ 无 projectId → 退化频道 current-pmo', async () => {
    mockGetChain.mockResolvedValue(chain(null, []));
    mockGetCurrentPmo.mockResolvedValue({ data: { data: { id: 'proj-9', pmoNumber: 'PMO-9', title: '频道项目', gitRepos: [] } } });
    mockProjectGet.mockResolvedValue({ data: { pmoNumber: 'PMO-9', title: '频道项目' } });
    renderRail({ reqs: [req('REQ-0001')] });

    const badge = await screen.findByText(/PMO-9 · 频道项目/);
    fireEvent.click(badge);
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-9');
  });

  it('两级都没有 / 项目记录拉不到 → 不渲染 badge（无死按钮）', async () => {
    mockGetChain.mockResolvedValue(chain(null, []));
    mockProjectGet.mockRejectedValue(new Error('gone'));
    renderRail({ reqs: [req('REQ-0001'), req('REQ-0002')] });

    await screen.findByText('REQ-0001');
    await waitFor(() => expect(mockGetChain).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/PMO-/)).toBeNull();
    expect(screen.queryByText(/↗/)).toBeNull();
  });
});

describe('ChannelActivityRail — Agent 链接（§4.3）', () => {
  it('assigneeId 解析到角色 → @名字 ↗ 跳 /agents/:roleId；解析不到不渲染', async () => {
    mockGetChain.mockImplementation((id: string) => Promise.resolve(
      id === 'REQ-0001'
        ? chain(null, [{ id: 'wu-a', status: 'active', assigneeId: 'inst-1' }])
        : chain(null, [{ id: 'wu-b', status: 'active', assigneeId: 'inst-x' }]),
    ));
    mockResolveAssignee.mockImplementation((aid: string) => Promise.resolve(
      aid === 'inst-1' ? { name: '分析师', roleId: 'role-1' } : null,
    ));
    renderRail({ reqs: [req('REQ-0001'), req('REQ-0002')] });

    const link = await screen.findByText(/@分析师/);
    expect(link.textContent).toContain('↗');
    fireEvent.click(link);
    expect(mockNavigate).toHaveBeenCalledWith('/agents/role-1');
    // inst-x 解析不到 → 不渲染成链接
    await waitFor(() => expect(mockResolveAssignee).toHaveBeenCalledWith('inst-x'));
    expect(screen.queryByText(/inst-x/)).toBeNull();
  });
});

describe('ChannelActivityRail — 动态归属与其他动态（§4.2）', () => {
  // #416：右栏改消费消息摘要投影（页面侧 projectActivityMessages 产物），测试直接构造条目
  function wuItem(id: string, wuId: string): ChannelActivityItem {
    return { id, kind: 'wu', text: `内容${id}`, at: '2026-08-10T00:00:00Z', wuId };
  }

  it('WU 消息经 chain 归属挂到 REQ 卡下；无归属落「其他动态」；条目点击开对应抽屉', async () => {
    mockGetChain.mockResolvedValue(chain(null, [{ id: 'wu-a', status: 'active' }]));
    const props = renderRail({
      reqs: [req('REQ-0001')],
      messageItems: [wuItem('m1', 'wu-a'), wuItem('m2', 'wu-zzz')],
    });

    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    expect(await within(card).findByText('内容m1')).toBeTruthy();

    expect(await screen.findByText('其他动态')).toBeTruthy();
    fireEvent.click(screen.getByText('内容m2'));
    expect(props.onOpenWu).toHaveBeenCalledWith('wu-zzz');

    fireEvent.click(within(card).getByText('内容m1'));
    expect(props.onOpenWu).toHaveBeenCalledWith('wu-a');
  });

  it('REQ 条目点击 → onOpenReq', async () => {
    mockGetChain.mockResolvedValue(chain(null, []));
    const props = renderRail({ reqs: [req('REQ-0001')] });
    // REQ 动态条目（kind=req）落在本卡动态区
    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    const row = await within(card).findByText(/REQ-0001 标题REQ-0001 · in-progress/);
    fireEvent.click(row);
    expect(props.onOpenReq).toHaveBeenCalledWith('REQ-0001');
  });

  it('无 REQ 且无动态 → 空态', async () => {
    renderRail();
    expect(await screen.findByText(/暂无/)).toBeTruthy();
  });

  // ② 其他动态降噪（docs/plans/2026-09-channel-visual-polish.md）：折叠与分级规则由 deriveActivityRows 纯函数覆盖，此处只锁组件接线
  it('② 同型 card 相邻折叠为一条 ×N；pinned 待办带 signal 类不折叠', async () => {
    renderRail({
      messageItems: [
        { id: 'm2', kind: 'card', text: 'daily_reflection 卡片 · 洞察 8-10', at: '2026-08-10T01:00:00Z' },
        { id: 'm1', kind: 'card', text: 'daily_reflection 卡片 · 洞察 8-09', at: '2026-08-10T00:00:00Z' },
      ],
      waitingWus: [{ wuId: 'wu-9', question: '确认方案？' }],
    });
    // 两条 daily_reflection 折叠为一条（代表 = 最新 m2），追加 ×2
    expect(await screen.findByText('daily_reflection 卡片 · 洞察 8-10 ×2')).toBeTruthy();
    expect(screen.queryByText(/洞察 8-09/)).toBeNull();
    // pinned 待办提权：signal 类落在行上
    const waitRow = (await screen.findByText(/等待人工回复/)).closest('.mc-act-row') as HTMLElement;
    expect(waitRow.className).toContain('mc-act-row-signal');
  });
});

describe('ChannelActivityRail — #412 chain 数据面 store（请求去重 + 右栏新鲜度）', () => {
  it('同 chain 会话内请求去重：卸载重挂 TTL 内零重拉', async () => {
    mockGetChain.mockResolvedValue(chain(null, [{ id: 'wu-a', status: 'active' }]));
    const props = {
      channelId: 'ch1',
      reqs: [req('REQ-0001')],
      messageItems: [] as ChannelActivityItem[],
      waitingWus: [],
      onOpenWu: vi.fn(),
      onOpenReq: vi.fn(),
    };
    const first = render(<ChannelActivityRail {...props} />);
    await screen.findByText('WU 0/1');
    expect(mockGetChain).toHaveBeenCalledTimes(1);

    first.unmount();
    render(<ChannelActivityRail {...props} />);
    await screen.findByText('WU 0/1');
    // 旧实现每次挂载逐 REQ 重拉；store 化后缓存命中零请求
    expect(mockGetChain).toHaveBeenCalledTimes(1);
  });

  it('REQ 集合变化只 ensure 新增 REQ：已缓存 chain 零重拉（旧 idsKey 全量重拉不复发）', async () => {
    mockGetChain.mockImplementation((id: string) =>
      Promise.resolve(chain(null, [{ id: `wu-${id}`, status: 'active' }])));
    const props = {
      channelId: 'ch1',
      reqs: [req('REQ-0001')],
      messageItems: [] as ChannelActivityItem[],
      waitingWus: [],
      onOpenWu: vi.fn(),
      onOpenReq: vi.fn(),
    };
    const view = render(<ChannelActivityRail {...props} />);
    await screen.findByText('WU 0/1');
    expect(mockGetChain).toHaveBeenCalledTimes(1);

    view.rerender(<ChannelActivityRail {...props} reqs={[req('REQ-0001'), req('REQ-0002')]} />);
    await screen.findByText('REQ-0002');
    await waitFor(() => expect(mockGetChain).toHaveBeenCalledTimes(2));
    expect(mockGetChain).toHaveBeenLastCalledWith('REQ-0002');
  });

  it('status_changed 后右栏 stepper 就地更新（WU n/m、交付站亮起），零请求', async () => {
    mockGetChain.mockResolvedValue(chain(null, [{ id: 'wu-a', status: 'active' }, { id: 'wu-b', status: 'done' }]));
    renderRail({ reqs: [req('REQ-0001')] });
    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    expect(await within(card).findByText('WU 1/2')).toBeTruthy();
    expect(within(card).getByText('交付').closest('.mc-act-step')!.className).toContain('mc-act-step-upcoming');
    expect(mockGetChain).toHaveBeenCalledTimes(1);

    // 与 App 级 sync 同一入口：store action 就地推导（旧实现 chain 不随事件更新，stepper 持续陈旧）
    act(() => {
      useRequirementChainStore.getState().applyWorkunitStatusChanged({
        id: 'wu-a', reqId: 'REQ-0001', status: 'done', scope: '任务wu-a', assigneeId: null,
        completedAt: '2026-08-01T02:00:00Z',
      });
    });

    expect(within(card).getByText('WU 2/2')).toBeTruthy();
    expect(within(card).getByText('交付').closest('.mc-act-step')!.className).toContain('mc-act-step-current');
    expect(mockGetChain).toHaveBeenCalledTimes(1); // 未重拉
  });
});
