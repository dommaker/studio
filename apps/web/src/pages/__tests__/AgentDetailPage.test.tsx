// Contract test: AgentDetailPage — /agents/:profileId（2026-07-31 §5.3：正在执行 + 历史任务 + 统计）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockListAllAgents, mockListChannels, mockGetAgentSummary, mockWuList, mockWuGet, mockListExecSteps, sse } = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockWuList: vi.fn(),
  mockWuGet: vi.fn(),
  mockListExecSteps: vi.fn(),
  // SSE 注册口捕获（#318：页面与内嵌 ExecutionSteps 都经 useWebSocketContext 订阅，广播全体）
  sse: {
    handlers: [] as Array<(msg: { event_type: string; data: unknown }) => void>,
    reconnects: [] as Array<() => void>,
  },
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
  useParams: () => ({ profileId: 'p1' }),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents, list: mockListChannels },
}));

vi.mock('../../api/workunit', async () => {
  const actual = await vi.importActual('../../api/workunit');
  return {
    ...actual,
    workunitApi: { list: mockWuList, get: mockWuGet, listExecutionStepEvents: mockListExecSteps },
  };
});

// SSE：测试无 WebSocketProvider，Layer B 步内流式置空；useWebSocketContext 捕获订阅回调供用例广播
vi.mock('../../hooks/useWorkUnitStreamEvents', () => ({
  useWorkUnitStreamEvents: () => [],
}));
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({
    onEvent: (fn: (msg: { event_type: string; data: unknown }) => void) => {
      sse.handlers.push(fn);
      return () => { sse.handlers = sse.handlers.filter(h => h !== fn); };
    },
    onReconnect: (fn: () => void) => {
      sse.reconnects.push(fn);
      return () => { sse.reconnects = sse.reconnects.filter(h => h !== fn); };
    },
  }),
}));

vi.mock('../../api/index', () => ({
  api: { post: vi.fn().mockResolvedValue({}) },
}));

import { AgentDetailPage } from '../../pages/AgentDetailPage';

const profile = {
  id: 'p1', name: 'dev-agent', description: 'writes code', status: 'active', provider: 'claude', isOnline: true,
};

const busyInstance = {
  id: 'i1', roleId: 'p1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-1',
  startedAt: '2026-07-31T08:00:00Z',
  currentWorkUnit: { id: 'wu-1', title: '实现登录接口', type: 'DEV', status: 'active', claimedAt: '2026-07-31T09:00:00Z' },
  pmo: { id: 'pmo1', pmoNumber: 'PMO-7', title: '用户系统' },
  channelId: 'ch1',
};

function mockApis({ agents = [busyInstance], profiles = [profile] }: { agents?: unknown[]; profiles?: unknown[] } = {}) {
  mockListAllAgents.mockResolvedValue({ data: { data: profiles } });
  mockGetAgentSummary.mockResolvedValue({
    data: { agents, summary: { total: agents.length, idle: 0, active: 1, error: 0, terminated: 0 } },
  });
}

describe('AgentDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sse.handlers.length = 0;
    sse.reconnects.length = 0;
    mockApis();
    mockListChannels.mockResolvedValue({ data: { success: true, data: [{ id: 'ch1', name: 'backend', type: 'dev' }] } });
    mockWuGet.mockResolvedValue({ data: { id: 'wu-2', scope: '补查任务', type: 'FIX', status: 'active', claimedAt: null } });
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockWuList.mockResolvedValue({
      data: {
        data: [
          { id: 'wu-1', scope: '实现登录接口', type: 'DEV', status: 'active', failureType: null, completedAt: null, updatedAt: '2026-07-31T09:00:00Z' },
          { id: 'wu-0', scope: '旧的首页改造', type: 'DEV', status: 'done', failureType: null, completedAt: '2026-07-30T10:00:00Z', updatedAt: '2026-07-30T10:00:00Z' },
          { id: 'wu-x', scope: '失败的迁移', type: 'OPS', status: 'done', failureType: 'timeout', completedAt: '2026-07-29T10:00:00Z', updatedAt: '2026-07-29T10:00:00Z' },
        ],
        // 对齐真实 API 响应形状（formatPaginatedResponse）：总数在 pagination.total（#309）
        pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
      },
    });
  });

  it('Header：角色名 / CLI / 状态 pill / 频道链接 / ID / 返回', async () => {
    render(<AgentDetailPage />);
    expect(await screen.findByText('dev-agent')).toBeDefined();
    expect(screen.getByText('CLI: claude')).toBeDefined();
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
    expect(screen.getAllByText('#backend')[0].closest('a')?.getAttribute('href')).toBe('/channels/ch1');
    expect(screen.getByText('p1')).toBeDefined();
    expect(screen.getByText('i1')).toBeDefined();
    expect(screen.getByText('返回 /agents').closest('a')?.getAttribute('href')).toBe('/agents');
    expect(screen.getByText('强制停止')).toBeDefined();
  });

  it('正在执行大卡：WU 标题/状态/已耗时/PMO 链接 + 执行流区块', async () => {
    render(<AgentDetailPage />);
    // 标题同时出现在大卡与历史列表，任一链接指向 WU 详情即可
    const titles = await screen.findAllByText('实现登录接口');
    expect(titles.some((el) => el.closest('a')?.getAttribute('href') === '/workunits/wu-1')).toBe(true);
    expect(screen.getByText('正在执行')).toBeDefined();
    expect(screen.getByText(/已耗时/)).toBeDefined();
    expect(screen.getByText('PMO-7 · 用户系统').closest('a')?.getAttribute('href')).toBe('/pmo/project/pmo1');
    // ExecutionSteps 嵌入（空态文案证明组件已挂载）
    expect(await screen.findByText(/暂无执行过程记录/)).toBeDefined();
  });

  it('无当前 WU → 空态「当前空闲」，不渲染执行流', async () => {
    mockApis({ agents: [{ ...busyInstance, status: 'idle', currentWorkUnitId: null, currentWorkUnit: null, pmo: null, channelId: null }] });
    render(<AgentDetailPage />);
    expect(await screen.findByText('当前空闲')).toBeDefined();
    expect(screen.queryByText('执行过程')).toBeNull();
  });

  it('后端聚合字段暂缺（只有 currentWorkUnitId）→ 按裸 ID 补查 WU 详情', async () => {
    mockApis({ agents: [{ ...busyInstance, currentWorkUnitId: 'wu-2', currentWorkUnit: undefined, pmo: undefined }] });
    render(<AgentDetailPage />);
    const title = await screen.findByText('补查任务');
    expect(title.closest('a')?.getAttribute('href')).toBe('/workunits/wu-2');
    expect(mockWuGet).toHaveBeenCalledWith('wu-2');
  });

  it('历史任务列表（assigneeId=instance.id）+ 统计行推导', async () => {
    render(<AgentDetailPage />);
    const row = await screen.findByText('旧的首页改造');
    expect(row.closest('a')?.getAttribute('href')).toBe('/workunits/wu-0');
    expect(mockWuList).toHaveBeenCalledWith({ assigneeId: 'i1', limit: 20 });
    // 统计：total=3，完成 2（done×2），在途 1（active），失败 1（failureType）
    const statValue = (label: string) => screen.getByText(label).previousElementSibling?.textContent;
    expect(statValue('历史总数')).toBe('3');
    expect(statValue('完成')).toBe('2');
    expect(statValue('在途')).toBe('1');
    expect(statValue('失败')).toBe('1');
  });

  it('角色不存在 → 未找到空态', async () => {
    mockApis({ profiles: [], agents: [] });
    render(<AgentDetailPage />);
    expect(await screen.findByText('未找到该角色')).toBeDefined();
  });

  it('instance 缺失（角色从未启动）→ 页面不崩，空闲态', async () => {
    mockApis({ agents: [] });
    render(<AgentDetailPage />);
    expect(await screen.findByText('dev-agent')).toBeDefined();
    await waitFor(() => expect(screen.getByText('当前空闲')).toBeDefined());
    expect(screen.queryByText('强制停止')).toBeNull();
  });
});

// #318：SSE 负载直更——instance status_changed 就地更新（含 additive pmo/startedAt，旧形状回退保留）、
// workunit.status_changed 历史行就地 + 低频防抖重拉（只历史区 1 接口）、重连一次性整页 refetch
describe('AgentDetailPage — SSE 负载直更（#318）', () => {
  const emitSse = (msg: { event_type: string; data: unknown }) => {
    act(() => { sse.handlers.forEach(h => h(msg)); });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sse.handlers.length = 0;
    sse.reconnects.length = 0;
    mockApis();
    mockListChannels.mockResolvedValue({ data: { success: true, data: [{ id: 'ch1', name: 'backend', type: 'dev' }] } });
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockWuList.mockResolvedValue({
      data: {
        data: [
          { id: 'wu-1', scope: '实现登录接口', type: 'DEV', status: 'active', failureType: null, completedAt: null, updatedAt: '2026-07-31T09:00:00Z' },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    });
  });

  it('instance status_changed（profileId 匹配）→ 就地更新状态/当前 WU/pmo，不整页 load', async () => {
    render(<AgentDetailPage />);
    expect(await screen.findByText('PMO-7 · 用户系统')).toBeDefined();
    emitSse({
      event_type: 'agent.instance.status_changed',
      data: {
        profileId: 'p1', instanceId: 'i1', name: 'dev-agent', status: 'idle',
        currentWorkUnitId: null, currentWorkUnit: null, channelId: null,
        pmo: null, startedAt: '2026-07-31T08:00:00Z', lastError: null, lastErrorAt: null,
      },
    });
    expect(await screen.findByText('当前空闲')).toBeDefined();
    expect(screen.queryByText('PMO-7 · 用户系统')).toBeNull();
    // 负载直更：不得触发整页重拉
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
  });

  it('旧形状负载（缺 pmo/startedAt 键）→ 回退保留原值（ADR D2）', async () => {
    render(<AgentDetailPage />);
    expect(await screen.findByText('PMO-7 · 用户系统')).toBeDefined();
    emitSse({
      event_type: 'agent.instance.status_changed',
      data: {
        profileId: 'p1', instanceId: 'i1', name: 'dev-agent', status: 'active',
        currentWorkUnitId: 'wu-1',
        currentWorkUnit: { id: 'wu-1', title: '实现登录接口', type: 'DEV', status: 'active', claimedAt: '2026-07-31T09:00:00Z' },
        channelId: 'ch1', lastError: null, lastErrorAt: null,
      },
    });
    await waitFor(() => expect(sse.handlers.length).toBeGreaterThan(0));
    // pmo / startedAt 保留原值
    expect(screen.getByText('PMO-7 · 用户系统')).toBeDefined();
    expect(screen.getByText(/运行:/)).toBeDefined();
  });

  it('workunit.status_changed → 历史行与当前卡就地更新；防抖后只重拉历史区 1 接口', async () => {
    render(<AgentDetailPage />);
    expect((await screen.findAllByText('实现登录接口')).length).toBeGreaterThan(0);
    expect(mockWuList).toHaveBeenCalledTimes(1);
    emitSse({
      event_type: 'workunit.status_changed',
      data: {
        workunit: {
          id: 'wu-1', scope: '实现登录接口', type: 'DEV', status: 'in_review',
          assigneeId: 'i1', failureType: null, completedAt: null, updatedAt: '2026-07-31T10:00:00Z',
          metadata: null, createdAt: '2026-07-31T08:00:00Z', claimedAt: '2026-07-31T09:00:00Z',
        },
      },
    });
    // 就地更新即时可见（当前卡 + 历史行各一处）
    await waitFor(() => expect(screen.getAllByText('in_review').length).toBeGreaterThanOrEqual(1));
    // 不整页 load
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    // 取舍（b）：窗口/total 无事件语义 → 低频防抖后只重拉历史区接口
    await waitFor(() => expect(mockWuList).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(mockWuList).toHaveBeenLastCalledWith({ assigneeId: 'i1', limit: 20 });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
  });

  it('SSE 重连 → 一次性整页 refetch 对齐（ADR D3）', async () => {
    render(<AgentDetailPage />);
    expect(await screen.findByText('dev-agent')).toBeDefined();
    await waitFor(() => expect(sse.reconnects.length).toBeGreaterThan(0));
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    act(() => { sse.reconnects.forEach(fn => fn()); });
    await waitFor(() => expect(mockGetAgentSummary).toHaveBeenCalledTimes(2));
  });
});
