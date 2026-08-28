// AgentDashboardPage — #348 render-count 测试：模拟 workunit.execution.stream chunk 到达，
// 断言静态卡壳零重渲（Link 探针按 /agents/:id 分卡计数——每张卡必渲角色名链接，卡重渲则计数必增；
// 目标卡动态刷新证明 chunk 确实到达，且经卡片自订的 rosterActivityStore 切片只重渲该卡）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

const {
  mockListAllAgents, mockListChannels, mockGetAgentSummary, mockTerminateInstance,
  mockWuList, mockWuGet, mockOnEvent, mockNavigate, linkRenderCount,
} = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockTerminateInstance: vi.fn(),
  mockWuList: vi.fn(),
  mockWuGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockNavigate: vi.fn(),
  linkRenderCount: {} as Record<string, number>,
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) => {
    if (typeof to === 'string' && to.startsWith('/agents/')) linkRenderCount[to] = (linkRenderCount[to] ?? 0) + 1;
    return React.createElement('a', { href: to, ...rest }, children);
  },
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

const profile = (id: string, name: string) => ({
  id, name, description: '', status: 'active', provider: 'claude', isOnline: true,
});

const instance = (roleId: string, instanceId: string, wuId: string, wuTitle: string) => ({
  id: instanceId, roleId, name: roleId === 'p1' ? 'dev-agent' : 'ops-agent', status: 'active',
  currentWorkUnitId: wuId, startedAt: new Date().toISOString(),
  currentWorkUnit: { id: wuId, title: wuTitle, type: 'DEV', status: 'active', claimedAt: new Date().toISOString() },
  pmo: null, channelId: null,
});

type SseHandler = (msg: { event_type: string; data?: unknown }) => void;
let sseHandler: SseHandler | null = null;

const emitStreamChunk = (text: string) => {
  act(() => {
    sseHandler!({
      event_type: 'workunit.execution.stream',
      data: { workUnitId: 'wu-1', executionId: 'e1', step: 2, kind: 'thinking', text, at: new Date().toISOString() },
    });
  });
};

describe('AgentDashboardPage — #348 stream chunk 掀不掀静态卡', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(linkRenderCount)) delete linkRenderCount[k];
    sseHandler = null;
    mockOnEvent.mockImplementation((h: SseHandler) => { sseHandler = h; return () => {}; });
    mockTerminateInstance.mockResolvedValue({});
    mockListAllAgents.mockResolvedValue({ data: { data: [profile('p1', 'dev-agent'), profile('p2', 'ops-agent')] } });
    mockGetAgentSummary.mockResolvedValue({
      data: {
        agents: [instance('p1', 'i1', 'wu-1', '实现登录接口'), instance('p2', 'i2', 'wu-2', '清理定时任务')],
        summary: { total: 2, idle: 0, active: 2, error: 0, terminated: 0 },
      },
    });
    mockListChannels.mockResolvedValue({ data: { success: true, data: [] } });
    mockWuList.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 20 } });
    mockWuGet.mockResolvedValue({ data: { id: 'wu-9', scope: '补查的任务', type: 'DEV', status: 'active', claimedAt: null } });
  });

  it('stream chunk 只重渲目标卡，静态卡壳零重渲', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('实现登录接口')).toBeDefined();
    expect(screen.getByText('清理定时任务')).toBeDefined();

    // 竞态加固（同页测试先例）：冲刷 passive effect，名册镜像落定后再取渲染基数
    await act(async () => {});
    const baseP1 = linkRenderCount['/agents/p1'];
    const baseP2 = linkRenderCount['/agents/p2'];
    expect(baseP1).toBeGreaterThan(0);
    expect(baseP2).toBeGreaterThan(0);

    // wu-1（p1 卡）连发 3 个 stream chunk
    emitStreamChunk('先读现有实现');
    emitStreamChunk('定位到 auth 模块');
    emitStreamChunk('准备动手修改');
    expect(await screen.findByText(/思考：准备动手修改/)).toBeDefined();

    // 目标卡重渲来自它自订的 store 切片（chunk 不再掀页面整树）——计数增长 = 订阅链路生效
    expect(linkRenderCount['/agents/p1']).toBeGreaterThan(baseP1);
    // 静态卡壳 p2 零重渲
    expect(linkRenderCount['/agents/p2']).toBe(baseP2);
  });
});
