// useAgentRoster — 角色名册 hook：合并加载 / SSE 事件路由 / 30s 轮询 / 内存上限 / terminate
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockListAllAgents, mockListChannels, mockGetAgentSummary, mockTerminateInstance, mockWuList, mockWuGet } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockTerminateInstance: vi.fn(),
  mockWuList: vi.fn(),
  mockWuGet: vi.fn(),
}));

vi.mock('../../api/websocket', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
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

import { useAgentRoster, MAX_ACTIVITIES, ROSTER_POLL_INTERVAL_MS } from '../useAgentRoster';

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'dev-agent', description: 'writes code', status: 'active', provider: 'claude', isOnline: true,
  ...overrides,
});

const instance = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1', roleId: 'p1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-1',
  startedAt: new Date().toISOString(),
  currentWorkUnit: { id: 'wu-1', title: '实现登录接口', type: 'DEV', status: 'active', claimedAt: new Date().toISOString() },
  ...overrides,
});

async function flush() {
  await act(async () => {});
}

describe('useAgentRoster', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockOnEvent.mockReturnValue(() => {});
    mockListAllAgents.mockResolvedValue({ data: { data: [profile()] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [instance()], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { data: [{ id: 'ch1', name: 'backend' }] } });
    mockWuList.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 20 } });
    mockWuGet.mockResolvedValue({ data: { id: 'wu-9', scope: '补查的任务', type: 'DEV', status: 'active', claimedAt: null } });
    mockTerminateInstance.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始加载：profile × runtime 按 roleId 合并，频道名入库，忙碌卡不查最近完成', async () => {
    const { result } = renderHook(() => useAgentRoster());
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.roles).toHaveLength(1);
    expect(result.current.roles[0].profile.id).toBe('p1');
    expect(result.current.roles[0].runtime?.id).toBe('i1');
    expect(result.current.roles[0].runtime?.currentWorkUnit?.title).toBe('实现登录接口');
    expect(result.current.channelNames).toEqual({ ch1: 'backend' });
    expect(mockWuList).not.toHaveBeenCalled();
  });

  it('空闲角色：按 instance.id 查 assigneeId 取最近完成；聚合字段暂缺时 fillWorkUnit 补查', async () => {
    mockListAllAgents.mockResolvedValue({ data: { data: [profile(), profile({ id: 'p2', name: 'ops-agent' })] } });
    mockGetAgentSummary.mockResolvedValue({
      data: {
        agents: [
          instance({ id: 'i1', status: 'idle', currentWorkUnitId: null, currentWorkUnit: null }),
          instance({ id: 'i2', roleId: 'p2', name: 'ops-agent', currentWorkUnitId: 'wu-9', currentWorkUnit: null }),
        ],
        summary: { total: 2, idle: 1, active: 1, error: 0, terminated: 0 },
      },
    });
    mockWuList.mockResolvedValue({
      data: {
        data: [
          { id: 'wu-old', scope: '旧任务', type: 'DEV', status: 'done', completedAt: '2026-07-30T00:00:00Z', updatedAt: '2026-07-30T00:00:00Z' },
          { id: 'wu-new', scope: '修好的首页', type: 'FIX', status: 'done', completedAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z' },
        ],
        total: 2, page: 1, limit: 20,
      },
    });
    const { result } = renderHook(() => useAgentRoster());
    await flush();
    // 空闲的 p1：最近完成取 done 里最新一条
    expect(mockWuList).toHaveBeenCalledWith({ assigneeId: 'i1', limit: 20 });
    expect(result.current.lastDone.p1?.id).toBe('wu-new');
    expect(result.current.lastDone.p2).toBeUndefined();
    // 忙碌的 p2：聚合字段暂缺 → 补查 wu-9 写回
    expect(mockWuGet).toHaveBeenCalledWith('wu-9');
    await flush();
    expect(result.current.roles[1].runtime?.currentWorkUnit?.title).toBe('补查的任务');
  });

  it('30s 轮询兜底：到点静默重拉', async () => {
    renderHook(() => useAgentRoster());
    await flush();
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(ROSTER_POLL_INTERVAL_MS); });
    expect(mockListAllAgents).toHaveBeenCalledTimes(2);
  });

  it('SSE agent.instance.status_changed：乐观更新卡片并增量补查 WU 详情', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [instance({ status: 'idle', currentWorkUnitId: null, currentWorkUnit: null })], summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 } },
    });
    const { result } = renderHook(() => useAgentRoster());
    await flush();
    expect(result.current.roles[0].runtime?.currentWorkUnitId).toBeNull();

    act(() => {
      handler!({ event_type: 'agent.instance.status_changed', data: { profileId: 'p1', instanceId: 'i1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-9' } });
    });
    expect(result.current.roles[0].runtime?.status).toBe('active');
    expect(result.current.roles[0].runtime?.currentWorkUnitId).toBe('wu-9');
    expect(mockWuGet).toHaveBeenCalledWith('wu-9');
    await flush();
    expect(result.current.roles[0].runtime?.currentWorkUnit?.title).toBe('补查的任务');
  });

  it('SSE workunit.status_changed：按 currentWorkUnitId 反查归属并更新 WU 快照', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    const { result } = renderHook(() => useAgentRoster());
    await flush();

    act(() => {
      handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'wu-1', scope: '实现登录接口 v2', status: 'in_review' } } });
    });
    expect(result.current.roles[0].runtime?.currentWorkUnit?.status).toBe('in_review');
    expect(result.current.roles[0].runtime?.currentWorkUnit?.title).toBe('实现登录接口 v2');
    // 不属于任何卡片的 WU 不动名册
    act(() => {
      handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'wu-elsewhere', status: 'done' } } });
    });
    expect(result.current.roles[0].runtime?.currentWorkUnit?.id).toBe('wu-1');
  });

  it('SSE workunit.execution.step：追加动态（工具调用优先文案）', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    const { result } = renderHook(() => useAgentRoster());
    await flush();

    act(() => {
      handler!({
        event_type: 'workunit.execution.step',
        data: { workUnitId: 'wu-1', executionId: 'e1', step: 3, action: 'progress', toolCalls: [{ tool: 'Edit', summary: 'src/auth.ts' }], at: '2026-08-06T00:00:00Z' },
      });
    });
    expect(result.current.activities.p1).toHaveLength(1);
    expect(result.current.activities.p1[0].text).toBe('🔧 Edit src/auth.ts');
    expect(result.current.activities.p1[0].key).toBe('step:3');
  });

  it('SSE workunit.execution.stream：共享 formatter 出文案，同 key 刷新同一行，上限截断', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    const { result } = renderHook(() => useAgentRoster());
    await flush();

    // 同一步的 thinking chunk 同 key 替换尾条
    act(() => {
      handler!({ event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-1', executionId: 'e1', step: 2, kind: 'thinking', text: '先读', at: 't1' } });
      handler!({ event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-1', executionId: 'e1', step: 2, kind: 'thinking', text: '先读现有实现', at: 't2' } });
    });
    expect(result.current.activities.p1).toHaveLength(1);
    expect(result.current.activities.p1[0].text).toBe('思考：先读现有实现');

    // tool chunk 无 key 逐条追加；result 也出文案（✓/✗）
    act(() => {
      handler!({ event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-1', executionId: 'e1', step: 2, kind: 'tool', tool: 'Read', summary: 'a.ts', at: 't3' } });
      handler!({ event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-1', executionId: 'e1', step: 2, kind: 'result', text: '', at: 't4' } });
    });
    expect(result.current.activities.p1.map((a) => a.text)).toEqual([
      '思考：先读现有实现',
      '🔧 Read a.ts',
      '✓ 回合结束',
    ]);

    // 超上限丢最旧（不同 step → 不同 key → 逐条追加）
    act(() => {
      for (let s = 3; s < 3 + MAX_ACTIVITIES; s++) {
        handler!({ event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-1', executionId: 'e1', step: s, kind: 'text', text: `step${s}`, at: `t${s}` } });
      }
    });
    expect(result.current.activities.p1).toHaveLength(MAX_ACTIVITIES);
    expect(result.current.activities.p1[0].text).not.toBe('思考：先读现有实现');

    // 其他 WU 的事件不落卡；坏 chunk 跳过
    act(() => {
      handler!({ event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-elsewhere', executionId: 'e9', step: 1, kind: 'text', text: '别人的', at: 'x' } });
      handler!({ event_type: 'workunit.execution.stream', data: { broken: true } });
    });
    expect(result.current.activities.p1).toHaveLength(MAX_ACTIVITIES);
    expect(result.current.activities.p1.every((a) => a.text !== '别人的')).toBe(true);
  });

  it('terminate：POST 后静默重拉；失败写入 error 不抛出', async () => {
    const { result } = renderHook(() => useAgentRoster());
    await flush();
    await act(async () => { await result.current.terminate('i1'); });
    expect(mockTerminateInstance).toHaveBeenCalledWith('i1');
    expect(mockListAllAgents).toHaveBeenCalledTimes(2);

    mockTerminateInstance.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { await result.current.terminate('i1'); });
    expect(result.current.error).toBe('boom');
  });

  it('unmount 退订并清掉轮询计时器', async () => {
    const unsub = vi.fn();
    mockOnEvent.mockReturnValue(unsub);
    renderHook(() => useAgentRoster()).unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(ROSTER_POLL_INTERVAL_MS * 2); });
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
  });
});
