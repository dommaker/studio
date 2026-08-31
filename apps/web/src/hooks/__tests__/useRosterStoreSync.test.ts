// useRosterStoreSync 单测 — #346 rosterStore 的 SSE/轮询接线
// 覆盖：引用计数单例（多挂载不放大订阅）、事件路由进 store、重连强制对齐、兜底轮询（TTL 门禁）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockOnReconnect, mockGetAgentSummary, mockListAllAgents, mockListChannels, mockCtx } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockCtx: { status: 'disconnected' as string },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect, status: mockCtx.status }),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents, list: mockListChannels },
}));

vi.mock('../../api/workunit', async () => {
  const actual = await vi.importActual('../../api/workunit');
  return { ...actual, workunitApi: { get: vi.fn().mockResolvedValue({ data: { id: 'x', scope: '', type: '', status: '', claimedAt: null } }) } };
});

import { useRosterStoreSync } from '../useRosterStoreSync';
import { useRosterStore } from '../../stores/rosterStore';
import { ROSTER_POLL_INTERVAL_MS } from '../../stores/rosterStore';

const agent = {
  id: 'i1', roleId: 'p1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-1',
  startedAt: '2026-08-01T00:00:00Z',
  currentWorkUnit: { id: 'wu-1', title: '实现登录接口', type: 'DEV', status: 'active', claimedAt: null },
};

function resetStore() {
  useRosterStore.setState({
    profiles: [], agents: [agent], channels: [],
    loading: false, error: null, forbidden: false,
    loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
    inflight: null, lastToken: null,
  });
}

async function flush() {
  await act(async () => {});
}

describe('useRosterStoreSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCtx.status = 'disconnected';
    resetStore();
    mockOnEvent.mockReturnValue(() => {});
    mockOnReconnect.mockReturnValue(() => {});
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [agent], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { data: [] } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('多挂载只注册一条 SSE 订阅（引用计数单例），全部卸载才退订', async () => {
    const unsub = vi.fn();
    mockOnEvent.mockReturnValue(unsub);
    const a = renderHook(() => useRosterStoreSync());
    const b = renderHook(() => useRosterStoreSync());
    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(unsub).not.toHaveBeenCalled();
    b.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('agent.instance.status_changed 路由进 store（就地更新）', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    renderHook(() => useRosterStoreSync());
    act(() => {
      handler!({ event_type: 'agent.instance.status_changed', data: { profileId: 'p1', instanceId: 'i1', status: 'idle', currentWorkUnitId: null, currentWorkUnit: null } });
    });
    expect(useRosterStore.getState().agents[0].status).toBe('idle');
  });

  it('workunit.status_changed 路由进 store（快照落加法更新）；无 id 忽略', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    renderHook(() => useRosterStoreSync());
    act(() => {
      handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'wu-1', scope: 'v2', status: 'in_review' } } });
      handler!({ event_type: 'workunit.status_changed', data: {} });
    });
    expect(useRosterStore.getState().agents[0].currentWorkUnit?.title).toBe('v2');
  });

  it('SSE 重连 → 强制 ensureFresh 对齐（ADR D3）', async () => {
    let reconnect: (() => void) | null = null;
    mockOnReconnect.mockImplementation((h: () => void) => { reconnect = h; return () => {}; });
    renderHook(() => useRosterStoreSync());
    await flush();
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1); // 挂载首拉
    act(() => { reconnect!(); });
    await flush();
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(2); // 重连强制（绕 TTL）
  });

  it('兜底轮询：SSE 断开且 visible 时到点 ensureFresh（TTL 门禁去重）', async () => {
    renderHook(() => useRosterStoreSync());
    await flush();
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    // 不到 TTL 推进：TTL 门禁挡住
    await act(async () => { vi.advanceTimersByTime(ROSTER_POLL_INTERVAL_MS - 1000); });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    // 过 TTL：轮询触发重拉
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(2);
  });

  it('SSE connected 时不起轮询计时器（useGatedPoll 门禁）', async () => {
    mockCtx.status = 'connected';
    renderHook(() => useRosterStoreSync());
    await flush();
    await act(async () => { vi.advanceTimersByTime(ROSTER_POLL_INTERVAL_MS * 3); });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
  });
});
