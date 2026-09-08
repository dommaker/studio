// useRequirementChainStoreSync 单测 — #412 chain 数据面接线的契约钉子：
// workunit.status_changed → store.applyWorkunitStatusChanged（更新逻辑唯一一份在 store）；
// SSE 重连 → ensureFresh({maxAgeMs:0}) 已缓存 chain 全量对齐；非本域事件 / 坏负载 no-op。
// 引用计数单例 / 门禁轮询契约由 useDataPlaneSync 套件锁定，此处不重复。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockOnReconnect, mockGetChain } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockGetChain: vi.fn(),
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect, status: 'disconnected' }),
}));
vi.mock('../useGatedPoll', () => ({ useGatedPoll: () => {} }));
vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));

import { useRequirementChainStoreSync } from '../useRequirementChainStoreSync';
import { useRequirementChainStore } from '../../stores/requirementChainStore';

let handler: ((msg: { event_type: string; data?: unknown }) => void) | null = null;

function chainFixture(reqId: string) {
  return {
    requirement: { id: reqId, seq: 1, title: `需求${reqId}`, status: 'in-progress', createdAt: '2026-08-01T00:00:00Z', createdBy: 'human' },
    workunits: [{ id: 'wu-1', title: '任务一', status: 'active', assigneeId: null, metadata: null }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  useRequirementChainStore.getState().__resetForTests();
  mockOnEvent.mockImplementation((h: typeof handler) => { handler = h; return () => {}; });
  mockOnReconnect.mockReturnValue(() => {});
});

describe('useRequirementChainStoreSync — SSE 路由', () => {
  it('workunit.status_changed → store 就地更新缓存 chain（不重拉）', async () => {
    mockGetChain.mockResolvedValue({ data: { success: true, data: chainFixture('REQ-1') } });
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    renderHook(() => useRequirementChainStoreSync());

    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'wu-1', reqId: 'REQ-1', status: 'done' } } }));

    expect(useRequirementChainStore.getState().chains['REQ-1']!.workunits[0].status).toBe('done');
    expect(mockGetChain).toHaveBeenCalledTimes(1);
  });

  it('非本域事件（requirement.created 等）→ no-op', async () => {
    mockGetChain.mockResolvedValue({ data: { success: true, data: chainFixture('REQ-1') } });
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    renderHook(() => useRequirementChainStoreSync());

    act(() => handler!({ event_type: 'requirement.created', data: { id: 'REQ-9' } }));
    act(() => handler!({ event_type: 'agent.instance.status_changed', data: { instanceId: 'a1' } }));

    expect(useRequirementChainStore.getState().chains['REQ-1']!.workunits[0].status).toBe('active');
    expect(mockGetChain).toHaveBeenCalledTimes(1);
  });

  it('坏负载（无信封 / 缺 id）→ no-op 不炸', () => {
    renderHook(() => useRequirementChainStoreSync());
    expect(() => {
      act(() => handler!({ event_type: 'workunit.status_changed', data: null }));
      act(() => handler!({ event_type: 'workunit.status_changed', data: {} }));
      act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: { status: 'done' } } }));
    }).not.toThrow();
    expect(useRequirementChainStore.getState().chains).toEqual({});
  });
});

describe('useRequirementChainStoreSync — 重连对齐', () => {
  it('onReconnect → ensureFresh({maxAgeMs:0})：已缓存 chain 强刷一次', async () => {
    let reconnect: (() => void) | null = null;
    mockOnReconnect.mockImplementation((h: () => void) => { reconnect = h; return () => {}; });
    mockGetChain.mockResolvedValue({ data: { success: true, data: chainFixture('REQ-1') } });
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    renderHook(() => useRequirementChainStoreSync());

    act(() => reconnect!());
    await vi.waitFor(() => expect(mockGetChain).toHaveBeenCalledTimes(2));
    expect(mockGetChain).toHaveBeenLastCalledWith('REQ-1');
  });
});
