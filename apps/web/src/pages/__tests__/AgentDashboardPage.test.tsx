// Contract test: AgentDashboardPage — #397 信息全卡栅格（redesign §6 定稿变体 B）：
// 页头统计行 = 快速筛选 chip（与卡面状态同色对应、点击过滤/再点取消、「在线」移出）；
// 注意力排序栅格；创建角色弹框化（保存=就地刷新不跳页）。数据/实时委托 useAgentRoster（不变）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockListAllAgents, mockListChannels, mockCreateAgent, mockGetAgentSummary, mockTerminateInstance, mockWuList, mockWuGet, mockOnEvent, mockNavigate, mockApiGet } = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockCreateAgent: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockTerminateInstance: vi.fn(),
  mockWuList: vi.fn(),
  mockWuGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockNavigate: vi.fn(),
  mockApiGet: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary, terminateInstance: mockTerminateInstance },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents, list: mockListChannels, createAgent: mockCreateAgent },
}));

vi.mock('../../api/workunit', async () => {
  const actual = await vi.importActual('../../api/workunit');
  return { ...actual, workunitApi: { list: mockWuList, get: mockWuGet } };
});

// CreateRoleModal 的 runtime 清单走裸 api 实例（spread 实际模块，保留 authApi 等同模块导出给 authStore 等链路）
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return { ...actual, api: { ...actual.api, get: mockApiGet } };
});

// SSE：测试无 WebSocketProvider，onEvent 由用例接管
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

import { AgentDashboardPage } from '../../pages/AgentDashboardPage';
import { useRosterStore } from '../../stores/rosterStore';

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'dev-agent', description: 'writes code', status: 'active', provider: 'claude', isOnline: true,
  ...overrides,
});

const instance = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1', roleId: 'p1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-1',
  startedAt: new Date().toISOString(),
  currentWorkUnit: { id: 'wu-1', title: '实现登录接口', type: 'DEV', status: 'active', claimedAt: new Date().toISOString() },
  pmo: { id: 'pmo1', pmoNumber: 'PMO-7', title: '用户系统' },
  channelId: 'ch1',
  ...overrides,
});

function mockApis({ profiles = [profile()], agents = [instance()] }: { profiles?: unknown[]; agents?: unknown[] } = {}) {
  mockListAllAgents.mockResolvedValue({ data: { data: profiles } });
  mockGetAgentSummary.mockResolvedValue({
    data: { agents, summary: { total: agents.length, idle: 0, active: 1, error: 0, terminated: 0 } },
  });
}

describe('AgentDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // rosterStore 是模块单例：TTL 锚点（loadedAt）与 403 终态（forbidden）跨用例残留会让
    // 后续用例的挂载首拉被 ensureFresh 门禁短路（拿不到当用例 mock 的数据）；每用例重置回初始态
    useRosterStore.setState({
      profiles: [], agents: [], channels: [], loading: false, error: null,
      forbidden: false, loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
      inflight: null, lastToken: null,
    });
    mockOnEvent.mockImplementation(() => () => {});
    mockTerminateInstance.mockResolvedValue({});
    mockCreateAgent.mockResolvedValue({ data: {} });
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { success: true, data: [{ id: 'ch1', name: 'backend', type: 'dev' }] } });
    mockWuList.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 20 } });
    mockWuGet.mockResolvedValue({ data: { id: 'wu-9', scope: '补查的任务', type: 'DEV', status: 'active', claimedAt: null } });
    mockApiGet.mockResolvedValue({ data: { runtimes: [] } });
  });

  it('renders page title', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('Agent 管理')).toBeDefined();
  });

  it('shows empty state when no roles', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('暂无角色')).toBeDefined();
  });

  // #283：monitoring 接口 Admin-only，非 Admin 渲染「无权限」终态
  it('monitoring 403 → 渲染「无权限」终态而非恒加载/英文错误', async () => {
    const err = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
    mockGetAgentSummary.mockRejectedValue(err);
    render(<AgentDashboardPage />);
    expect(await screen.findByText(/无权限查看 Agent 运行数据/)).toBeDefined();
    expect(screen.queryByText('加载中...')).toBeNull();
    expect(screen.queryByText(/Request failed with status code 403/)).toBeNull();
  });

  it('§6.3 页头统计行 = 快速筛选 chip：七档齐全、「在线」不在筛选行', async () => {
    mockApis();
    render(<AgentDashboardPage />);
    expect(await screen.findByText('实现登录接口')).toBeDefined();
    for (const label of ['总数', '执行中', '待评审', '阻塞', '异常', '空闲', '未启动·停用']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeDefined();
    }
    expect(screen.queryByRole('button', { name: /在线/ })).toBeNull();
    expect(screen.queryByText('在线')).toBeNull();
  });

  it('§6.3 chip 点击过滤栅格、再点取消', async () => {
    mockApis({
      profiles: [profile(), profile({ id: 'p2', name: 'reviewer', provider: 'kimi' })],
      agents: [
        instance(),
        instance({ id: 'i2', roleId: 'p2', name: 'reviewer', currentWorkUnitId: 'wu-2',
          currentWorkUnit: { id: 'wu-2', title: '评审首页改版', type: 'REVIEW', status: 'blocked', claimedAt: new Date().toISOString() },
          pmo: null, channelId: null }),
      ],
    });
    render(<AgentDashboardPage />);
    expect(await screen.findByText('实现登录接口')).toBeDefined();
    expect(screen.getByText('评审首页改版')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /阻塞/ }));
    expect(screen.queryByText('实现登录接口')).toBeNull();
    expect(screen.getByText('评审首页改版')).toBeDefined();

    // 再点取消 → 全量恢复
    fireEvent.click(screen.getByRole('button', { name: /阻塞/ }));
    expect(await screen.findByText('实现登录接口')).toBeDefined();
    expect(screen.getByText('评审首页改版')).toBeDefined();
  });

  it('§6.2 注意力排序：阻塞/异常卡排在执行中之前', async () => {
    mockApis({
      profiles: [profile(), profile({ id: 'p2', name: 'blocker', provider: 'kimi' })],
      agents: [
        instance(),
        instance({ id: 'i2', roleId: 'p2', name: 'blocker', currentWorkUnitId: 'wu-2',
          currentWorkUnit: { id: 'wu-2', title: '被卡的迁移', type: 'DEV', status: 'blocked', claimedAt: new Date().toISOString() },
          pmo: null, channelId: null }),
      ],
    });
    const { container } = render(<AgentDashboardPage />);
    expect(await screen.findByText('被卡的迁移')).toBeDefined();
    const statuses = Array.from(container.querySelectorAll('[data-testid="agent-card"]'))
      .map((el) => el.getAttribute('data-status'));
    expect(statuses).toEqual(['blocked', 'running']);
  });

  it('§6.1 忙碌卡四层：pill+角色名链接+CLI chip+运行时长 → WU 锚点+类型 chip+已耗时 → PMO·频道次行', async () => {
    mockApis();
    render(<AgentDashboardPage />);
    const title = await screen.findByText('实现登录接口');
    const card = title.closest('[data-testid="agent-card"]')!;
    expect(card.getAttribute('data-status')).toBe('running');
    // 头行
    expect(within(card as HTMLElement).getByText('执行中')).toBeDefined();
    expect(within(card as HTMLElement).getByText('dev-agent').closest('a')?.getAttribute('href')).toBe('/agents/p1');
    expect(within(card as HTMLElement).getByText('claude')).toBeDefined();
    expect(within(card as HTMLElement).getByText(/^\d+m$/)).toBeDefined();
    // 视觉锚点
    expect(title.closest('a')?.getAttribute('href')).toBe('/workunits/wu-1');
    expect(within(card as HTMLElement).getByText('DEV')).toBeDefined();
    expect(within(card as HTMLElement).getByText(/已耗时/)).toBeDefined();
    // 次行 PMO · 频道
    expect(within(card as HTMLElement).getByText('PMO-7 · 用户系统').closest('a')?.getAttribute('href')).toBe('/pmo/project/pmo1');
    expect(within(card as HTMLElement).getByText('#backend').closest('a')?.getAttribute('href')).toBe('/channels/ch1');
  });

  it('active + WU in_review → 待评审（data-status=in_review）；blocked → 阻塞', async () => {
    mockApis({
      agents: [instance({ currentWorkUnit: { id: 'wu-1', title: 't', type: 'DEV', status: 'in_review', claimedAt: null } })],
    });
    const { unmount, container } = render(<AgentDashboardPage />);
    expect(await screen.findByText('待评审')).toBeDefined();
    expect(container.querySelector('[data-testid="agent-card"]')?.getAttribute('data-status')).toBe('in_review');
    unmount();

    // 同测试内二次挂载：重置 TTL 锚点，挂载首拉才会取到本轮 mock 的数据
    useRosterStore.setState({ profiles: [], agents: [], loadedAt: null });
    mockApis({
      agents: [instance({ currentWorkUnit: { id: 'wu-1', title: 't', type: 'DEV', status: 'blocked', claimedAt: null } })],
    });
    const { container: c2 } = render(<AgentDashboardPage />);
    expect(await screen.findByText('阻塞')).toBeDefined();
    expect(c2.querySelector('[data-testid="agent-card"]')?.getAttribute('data-status')).toBe('blocked');
  });

  it('§6.1 空闲空态：等待派活 + 最近完成链接（assigneeId 查询取 done）', async () => {
    mockApis({ agents: [instance({ status: 'idle', currentWorkUnitId: null, currentWorkUnit: null, pmo: null, channelId: null })] });
    mockWuList.mockResolvedValue({
      data: {
        data: [
          { id: 'wu-old', scope: '旧任务', type: 'DEV', status: 'done', completedAt: '2026-07-30T00:00:00Z', updatedAt: '2026-07-30T00:00:00Z' },
          { id: 'wu-new', scope: '修好的首页', type: 'FIX', status: 'done', completedAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z' },
        ],
        total: 2, page: 1, limit: 20,
      },
    });
    render(<AgentDashboardPage />);
    expect(await screen.findByText(/空闲 · 等待派活/)).toBeDefined();
    const done = await screen.findByText('修好的首页');
    expect(done.closest('a')?.getAttribute('href')).toBe('/workunits/wu-new');
    expect(mockWuList).toHaveBeenCalledWith({ assigneeId: 'i1', limit: 20 });
  });

  it('§6.1 无 instance → 未启动 pill + 未启动空态', async () => {
    mockApis({ agents: [] });
    const { container } = render(<AgentDashboardPage />);
    // pill 与空态文案同为「未启动」
    expect((await screen.findAllByText('未启动')).length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="agent-card"]')?.getAttribute('data-status')).toBe('none');
  });

  it('§6.1 异常卡：错误行 ⚠ lastError 上卡（与卡同色经 data-status=error 驱动）', async () => {
    mockApis({
      agents: [instance({ status: 'error', currentWorkUnitId: null, currentWorkUnit: null, pmo: null, channelId: null, lastError: 'spawn ENOENT' })],
    });
    const { container } = render(<AgentDashboardPage />);
    const err = await screen.findByText(/⚠ spawn ENOENT/);
    expect(container.querySelector('[data-testid="agent-card"]')?.getAttribute('data-status')).toBe('error');
    expect(err.className).toContain('agd-error');
  });

  it('SSE agent.instance.status_changed：更新卡片并增量补查 WU 详情', async () => {
    // onEvent 广播语义：useRosterStoreSync（状态面）与 useAgentRoster（执行动态）各注册一个 handler，
    // 事件要送达全部订阅者（捕获单个 handler 只会拿到最后注册的那个）
    const handlers: Array<(msg: unknown) => void> = [];
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handlers.push(h); return () => {}; });
    mockApis({ agents: [instance({ status: 'idle', currentWorkUnitId: null, currentWorkUnit: null, pmo: null, channelId: null })] });
    render(<AgentDashboardPage />);
    expect(await screen.findByText(/空闲 · 等待派活/)).toBeDefined();
    await act(async () => {}); // 同下方 step 用例：冲刷 passive effect，避免 rolesRef 陈旧窗口

    act(() => {
      for (const h of handlers) {
        h({ event_type: 'agent.instance.status_changed', data: { profileId: 'p1', instanceId: 'i1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-9' } });
      }
    });
    // 补查 wu-9 详情后显示标题链接 + 执行中 pill
    const title = await screen.findByText('补查的任务');
    expect(title.closest('a')?.getAttribute('href')).toBe('/workunits/wu-9');
    expect(mockWuGet).toHaveBeenCalledWith('wu-9');
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
  });

  it('SSE workunit.execution.step：最近动态每条可点 → 当前 WU 详情；他 WU 事件不落卡', async () => {
    // 同 status_changed 用例：广播到全部 onEvent 订阅者
    const handlers: Array<(msg: unknown) => void> = [];
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handlers.push(h); return () => {}; });
    mockApis();
    render(<AgentDashboardPage />);
    expect(await screen.findByText('实现登录接口')).toBeDefined();

    // 竞态加固：rolesRef 由 passive effect 镜像 roles；findByText 可经 MutationObserver
    // 微任务在 effect flush（宏任务）前决议，此时同步推送 SSE 会读到陈旧空名册、事件被
    // findRoleByWorkUnit 静默丢弃。async act 冲刷全部挂起 effect，推送时机确定化。
    await act(async () => {});

    act(() => {
      for (const h of handlers) {
        h({
          event_type: 'workunit.execution.step',
          data: { workUnitId: 'wu-1', executionId: 'e1', step: 3, action: 'progress', toolCalls: [{ tool: 'Edit', summary: 'src/auth.ts' }], at: new Date().toISOString() },
        });
      }
    });
    const row = await screen.findByText(/🔧 Edit src\/auth\.ts/);
    expect(row.closest('a')?.getAttribute('href')).toBe('/workunits/wu-1');
    // 其他 WU 的事件不落卡
    act(() => {
      for (const h of handlers) {
        h({
          event_type: 'workunit.execution.step',
          data: { workUnitId: 'wu-elsewhere', executionId: 'e2', step: 1, toolCalls: [{ tool: 'Bash', summary: 'rm -rf' }], at: new Date().toISOString() },
        });
      }
    });
    expect(screen.queryByText(/rm -rf/)).toBeNull();
  });

  it('§6.4 创建角色弹框化：勾选 runtime + 命名 → 创建 → 关弹框就地刷新名册，不跳页', async () => {
    mockApis();
    mockApiGet.mockResolvedValue({
      data: { runtimes: [{ nodeId: 'n1', provider: 'claude', version: '1.0.0', workspaceName: 'studio' }] },
    });
    render(<AgentDashboardPage />);
    expect(await screen.findByText('实现登录接口')).toBeDefined();
    const callsBefore = mockListAllAgents.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '创建角色' }));
    // 弹框就地打开，不 navigate
    expect(await screen.findByText(/检测到 1 个 runtime/)).toBeDefined();
    expect(mockNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByPlaceholderText(/角色名称/), { target: { value: 'qa-agent' } });
    fireEvent.click(screen.getByRole('button', { name: /创建选中角色/ }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith({ name: 'qa-agent', description: undefined, provider: 'claude' }));
    // 保存 = 关弹框 + 就地刷新名册（不跳页）
    await waitFor(() => expect(screen.queryByText(/检测到 1 个 runtime/)).toBeNull());
    await waitFor(() => expect(mockListAllAgents.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
