// #394 ChannelActivityRail — 频道动态右栏：REQ 链路卡（四站 stepper）+ 混合交互（REQ/WU 抽屉、PMO/Agent ↗ 跳页）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
import type { Requirement } from '../../../api/requirements';
import type { ChannelMessage } from '../../../api/channel';

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
    messages: [] as ChannelMessage[],
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
  function agentMsg(id: string, wuId: string | null): ChannelMessage {
    return {
      id, channelId: 'ch1', authorType: 'agent', content: `内容${id}`,
      createdAt: '2026-08-10T00:00:00Z', ...(wuId ? { workUnitId: wuId } : {}),
    } as ChannelMessage;
  }

  it('WU 消息经 chain 归属挂到 REQ 卡下；无归属落「其他动态」；条目点击开对应抽屉', async () => {
    mockGetChain.mockResolvedValue(chain(null, [{ id: 'wu-a', status: 'active' }]));
    const props = renderRail({
      reqs: [req('REQ-0001')],
      messages: [agentMsg('m1', 'wu-a'), agentMsg('m2', 'wu-zzz')],
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
});
