// useWorkUnitStoreSync 单测 — #549（B5 收口）的契约钉子：
// 同一事件（workunit.status_changed / created / workunit:removed）的 SSE 路由唯一一份在此——
// status_changed → applyWorkunitEvent(insertIfMissing:false)（存量行直替/过滤移除 + detail 就地 upsert）；
// created → applyWorkunitEvent(insertIfMissing:true) + markWuFresh（fresh 高亮集合）；
// workunit:removed → removeWorkunit；detail 未打开过的 WU 事件 no-op。
// 重连兜底仅在列表页在屏（store listOnScreen，#557 真实在屏信号替代空列表代理）时刷；
// 不加轮询（pollIntervalMs=0 停用）。
// 引用计数单例契约由 useDataPlaneSync 套件锁定，此处不重复。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockOnReconnect, mockWuList } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockWuList: vi.fn(),
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect, status: 'connected' }),
}));
vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockWuList },
}));

import { useWorkUnitStoreSync } from '../useWorkUnitStoreSync';
import { useWorkUnitStore } from '../../stores/workunitStore';
import type { WorkUnit } from '../../api/workunit';

let handler: ((msg: { event_type: string; data?: unknown }) => void) | null = null;

function wuFixture(id: string, over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id, parentId: null, dependsOn: '', type: 'task', scope: `任务${id}`,
    assigneeId: null, status: 'active', failureType: null, retryCount: 0,
    timeoutAt: null, channelId: 'ch-1', metadata: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    claimedAt: null, completedAt: null,
    ...over,
  };
}

function mount() {
  return renderHook(() => useWorkUnitStoreSync());
}

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  useWorkUnitStore.getState().__resetForTests();
  useWorkUnitStore.setState({
    workunits: [], total: 0, page: 1, limit: 20,
    statusFilter: null, typeFilter: null,
    unattributedOnly: false, unattributedTotal: null, allTotal: null,
    searchQuery: null, loading: false, error: null,
    listOnScreen: false,
  });
  mockOnEvent.mockImplementation((h: typeof handler) => { handler = h; return () => {}; });
  mockOnReconnect.mockReturnValue(() => {});
  mockWuList.mockResolvedValue({ data: { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } } });
});

describe('useWorkUnitStoreSync — SSE 路由（三路径唯一一份）', () => {
  it('status_changed → 存量行直替（insertIfMissing: false）；未知行不插入', () => {
    useWorkUnitStore.setState({ workunits: [wuFixture('wu-1')], total: 1 });
    mount();

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: wuFixture('wu-1', { status: 'done' }) } }));
    expect(useWorkUnitStore.getState().workunits[0].status).toBe('done');
    expect(useWorkUnitStore.getState().total).toBe(1);

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: wuFixture('wu-9') } }));
    expect(useWorkUnitStore.getState().workunits).toHaveLength(1);
  });

  it('status_changed 行变更后不符过滤 → 就地移除（过滤匹配语义在 store 单份）', () => {
    useWorkUnitStore.setState({ statusFilter: 'active', workunits: [wuFixture('wu-1')], total: 1 });
    mount();

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: wuFixture('wu-1', { status: 'done' }) } }));
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);
    expect(useWorkUnitStore.getState().total).toBe(0);
  });

  it('status_changed → 已打开 detail 就地 upsert；未打开 no-op（ADR 决策 2）', () => {
    useWorkUnitStore.setState({ detailById: { 'wu-1': { wu: wuFixture('wu-1'), notFound: false, error: null } } });
    mount();

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: wuFixture('wu-1', { status: 'done' }) } }));
    expect(useWorkUnitStore.getState().detailById['wu-1'].wu?.status).toBe('done');

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: wuFixture('wu-9') } }));
    expect(useWorkUnitStore.getState().detailById['wu-9']).toBeUndefined();
  });

  it('created → 插头部（insertIfMissing: true）+ fresh 标记；status_changed 不标 fresh', () => {
    mount();

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: wuFixture('wu-0') } }));
    expect(useWorkUnitStore.getState().freshWuIds.size).toBe(0);

    act(() => handler!({ event_type: 'workunit.created', data: { workunit: wuFixture('wu-1') } }));
    expect(useWorkUnitStore.getState().workunits.map(w => w.id)).toEqual(['wu-1']);
    expect(useWorkUnitStore.getState().freshWuIds.has('wu-1')).toBe(true);
  });

  it('workunit:removed → 删行；缺 id 坏负载 no-op（#538 路由同迁）', () => {
    useWorkUnitStore.setState({ workunits: [wuFixture('wu-1')], total: 1 });
    mount();

    act(() => handler!({ event_type: 'workunit:removed', data: { channelId: 'ch-1' } }));
    expect(useWorkUnitStore.getState().workunits).toHaveLength(1);

    act(() => handler!({ event_type: 'workunit:removed', data: { id: 'wu-1', channelId: null } }));
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);
  });

  it('坏负载 no-op 不炸', () => {
    mount();
    expect(() => {
      act(() => handler!({ event_type: 'workunit.status_changed', data: null }));
      act(() => handler!({ event_type: 'workunit.created', data: {} }));
      act(() => handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1' } }));
    }).not.toThrow();
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);
  });
});

describe('useWorkUnitStoreSync — 重连兜底（#557：真实在屏信号 listOnScreen，空列表 ≠ 不在屏）', () => {
  it('不在屏（listOnScreen=false）有负载也不刷；在屏但空列表（过滤无结果/首拉失败留空）照刷', async () => {
    let reconnect: (() => void) | null = null;
    mockOnReconnect.mockImplementation((h: () => void) => { reconnect = h; return () => {}; });

    // 页面不在屏：即便 store 留有负载也不做全量拉
    useWorkUnitStore.setState({ listOnScreen: false, workunits: [wuFixture('wu-1')], total: 1 });
    mount();
    act(() => reconnect!());
    await act(async () => {});
    expect(mockWuList).not.toHaveBeenCalled();

    // 在屏且空列表（过滤无结果 / 首拉失败留空）：重连照刷——复原 #549 前页面级 onReconnect 语义
    useWorkUnitStore.setState({ listOnScreen: true, workunits: [], total: 0 });
    act(() => reconnect!());
    await vi.waitFor(() => expect(mockWuList).toHaveBeenCalledTimes(3));
  });
});
