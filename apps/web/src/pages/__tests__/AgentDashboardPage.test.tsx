// Contract test: AgentDashboardPage — 作战视图（2026-07-31 §5.2：三段式卡片 + SSE 实时 + 强制停止）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockListAllAgents, mockListChannels, mockGetAgentSummary, mockTerminateInstance, mockWuList, mockWuGet, mockOnEvent, mockNavigate } = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockTerminateInstance: vi.fn(),
  mockWuList: vi.fn(),
  mockWuGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockNavigate: vi.fn(),
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
  channelApi: { listAllAgents: mockListAllAgents, list: mockListChannels },
}));

vi.mock('../../api/workunit', async () => {
  const actual = await vi.importActual('../../api/workunit');
  return { ...actual, workunitApi: { list: mockWuList, get: mockWuGet } };
});

// SSE：测试无 WebSocketProvider，onEvent 由用例接管
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

import { AgentDashboardPage } from '../../pages/AgentDashboardPage';

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
    mockOnEvent.mockImplementation(() => () => {});
    mockTerminateInstance.mockResolvedValue({});
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { success: true, data: [{ id: 'ch1', name: 'backend', type: 'dev' }] } });
    mockWuList.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 20 } });
    mockWuGet.mockResolvedValue({ data: { id: 'wu-9', scope: '补查的任务', type: 'DEV', status: 'active', claimedAt: null } });
  });

  it('renders page title', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('Agent 管理')).toBeDefined();
  });

  it('shows empty state when no roles', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('暂无角色')).toBeDefined();
  });

  it('手动刷新按钮已移除（数据 SSE 实时 + 轮询兜底），创建角色入口保留', async () => {
    render(<AgentDashboardPage />);
    expect(screen.getByText('创建角色')).toBeDefined();
    expect(screen.queryByText('刷新')).toBeNull();
    expect(await screen.findByText('暂无角色')).toBeDefined();
  });

  it('忙碌卡三段式：状态 pill + WU 标题/PMO/频道链接 + CLI badge', async () => {
    mockApis();
    render(<AgentDashboardPage />);
    const title = await screen.findByText('实现登录接口');
    expect(title.closest('a')?.getAttribute('href')).toBe('/workunits/wu-1');
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
    expect(screen.getByText('DEV')).toBeDefined();
    expect(screen.getByText('CLI: claude')).toBeDefined();
    // 角色名 → /agents/:id
    expect(screen.getByText('dev-agent').closest('a')?.getAttribute('href')).toBe('/agents/p1');
    // PMO + 频道链接
    expect(screen.getByText('PMO-7 · 用户系统').closest('a')?.getAttribute('href')).toBe('/pmo/project/pmo1');
    expect(screen.getByText('#backend').closest('a')?.getAttribute('href')).toBe('/channels/ch1');
    expect(screen.getByText(/已耗时/)).toBeDefined();
  });

  it('active + WU in_review → 待评审 pill；blocked → 阻塞 pill', async () => {
    mockApis({
      agents: [instance({ currentWorkUnit: { id: 'wu-1', title: 't', type: 'DEV', status: 'in_review', claimedAt: null } })],
    });
    const { unmount } = render(<AgentDashboardPage />);
    expect(await screen.findByText('待评审')).toBeDefined();
    unmount();

    mockApis({
      agents: [instance({ currentWorkUnit: { id: 'wu-1', title: 't', type: 'DEV', status: 'blocked', claimedAt: null } })],
    });
    render(<AgentDashboardPage />);
    expect(await screen.findByText('阻塞')).toBeDefined();
  });

  it('空闲卡：等待派活 + 最近完成（assigneeId 查询取 done）', async () => {
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
    expect(await screen.findByText('空闲 · 等待派活')).toBeDefined();
    const done = await screen.findByText('修好的首页');
    expect(done.closest('a')?.getAttribute('href')).toBe('/workunits/wu-new');
    expect(mockWuList).toHaveBeenCalledWith({ assigneeId: 'i1', limit: 20 });
  });

  it('无 instance → 未启动 pill', async () => {
    mockApis({ agents: [] });
    render(<AgentDashboardPage />);
    expect(await screen.findByText('未启动')).toBeDefined();
  });

  it('强制停止：ConfirmDialog 二次确认，确认后调 terminate 接口', async () => {
    mockApis();
    render(<AgentDashboardPage />);
    fireEvent.click(await screen.findByText('强制停止'));
    // 弹窗文案；未确认前不调接口
    expect(await screen.findByText('强制停止会将当前任务转人工处理，确认？')).toBeDefined();
    expect(mockTerminateInstance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }));
    await waitFor(() => expect(mockTerminateInstance).toHaveBeenCalledWith('i1'));
  });

  it('强制停止：取消则不调 terminate 接口', async () => {
    mockApis();
    render(<AgentDashboardPage />);
    fireEvent.click(await screen.findByText('强制停止'));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(mockTerminateInstance).not.toHaveBeenCalled();
    expect(screen.queryByText('强制停止会将当前任务转人工处理，确认？')).toBeNull();
  });

  it('SSE agent.instance.status_changed：更新卡片并增量补查 WU 详情', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    mockApis({ agents: [instance({ status: 'idle', currentWorkUnitId: null, currentWorkUnit: null, pmo: null, channelId: null })] });
    render(<AgentDashboardPage />);
    expect(await screen.findByText('空闲 · 等待派活')).toBeDefined();

    act(() => {
      handler!({ event_type: 'agent.instance.status_changed', data: { profileId: 'p1', instanceId: 'i1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-9' } });
    });
    // 补查 wu-9 详情后显示标题链接 + 执行中 pill
    const title = await screen.findByText('补查的任务');
    expect(title.closest('a')?.getAttribute('href')).toBe('/workunits/wu-9');
    expect(mockWuGet).toHaveBeenCalledWith('wu-9');
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
  });

  it('SSE workunit.execution.step：按 workUnitId 归属追加最近动态', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    mockApis();
    render(<AgentDashboardPage />);
    expect(await screen.findByText('实现登录接口')).toBeDefined();

    act(() => {
      handler!({
        event_type: 'workunit.execution.step',
        data: { workUnitId: 'wu-1', executionId: 'e1', step: 3, action: 'progress', toolCalls: [{ tool: 'Edit', summary: 'src/auth.ts' }], at: new Date().toISOString() },
      });
    });
    expect(await screen.findByText(/🔧 Edit src\/auth\.ts/)).toBeDefined();
    // 其他 WU 的事件不落卡
    act(() => {
      handler!({
        event_type: 'workunit.execution.step',
        data: { workUnitId: 'wu-elsewhere', executionId: 'e2', step: 1, toolCalls: [{ tool: 'Bash', summary: 'rm -rf' }], at: new Date().toISOString() },
      });
    });
    expect(screen.queryByText(/rm -rf/)).toBeNull();
  });

  it('展开卡片：最近动态列表 + 静态字段', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    mockApis();
    render(<AgentDashboardPage />);
    expect(await screen.findByText('dev-agent')).toBeDefined();
    act(() => {
      handler!({
        event_type: 'workunit.execution.stream',
        data: { workUnitId: 'wu-1', executionId: 'e1', step: 2, kind: 'thinking', text: '先读现有实现', at: new Date().toISOString() },
      });
    });
    fireEvent.click(screen.getByText('CLI: claude'));
    expect(await screen.findByText('最近动态')).toBeDefined();
    // 中段「最近一条」+ 展开列表各出现一次
    expect(screen.getAllByText(/思考：先读现有实现/).length).toBe(2);
    expect(screen.getByText('Profile ID:')).toBeDefined();
    expect(screen.getByText('Instance ID:')).toBeDefined();
    expect(screen.getByText('Runtime Status:')).toBeDefined();
  });
});
