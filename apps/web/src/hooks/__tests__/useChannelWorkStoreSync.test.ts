// useChannelWorkStoreSync 单测 — #528 频道工作面接线的契约钉子：
// 挂载设活跃频道并打底三 slice（wus/reqs TTL 门禁 + suggestions 即时）；SSE 事件只路由活跃频道——
// status_changed 全量快照直替 + 标脏建议防抖 / requirement.* envelope 解包 upsert + 标脏 /
// message_sent 标脏；重连 → ensureChannelWork({maxAgeMs:0}) 全 slice 强刷。
// 引用计数单例 / 门禁轮询契约由 useDataPlaneSync 套件锁定，此处不重复。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockOnReconnect, mockWuList, mockReqList, mockGetSuggestions } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockWuList: vi.fn(),
  mockReqList: vi.fn(),
  mockGetSuggestions: vi.fn(),
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect, status: 'disconnected' }),
}));
vi.mock('../useGatedPoll', () => ({ useGatedPoll: () => {} }));
vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockWuList, getChangedFiles: vi.fn() },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { list: mockReqList },
}));
vi.mock('../../api/channel', () => ({
  channelApi: { getSuggestions: mockGetSuggestions },
}));

import { useChannelWorkStoreSync } from '../useChannelWorkStoreSync';
import { useChannelWorkStore, SUGGESTIONS_RELOAD_DEBOUNCE_MS } from '../../stores/channelWorkStore';
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

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  useChannelWorkStore.getState().__resetForTests();
  mockOnEvent.mockImplementation((h: typeof handler) => { handler = h; return () => {}; });
  mockOnReconnect.mockReturnValue(() => {});
  mockWuList.mockResolvedValue({ data: { success: true, data: [wuFixture('wu-1')] } });
  mockReqList.mockResolvedValue({ data: { success: true, data: [] } });
  mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { suggestions: [], currentWuId: null } } });
});

async function mount(channelId = 'ch-1') {
  const utils = renderHook((props: { id: string }) => useChannelWorkStoreSync(props.id), { initialProps: { id: channelId } });
  await act(async () => {}); // 等挂载打底的微任务链落地
  return utils;
}

describe('useChannelWorkStoreSync — 挂载打底', () => {
  it('挂载即拉 wus/reqs/suggestions 三 slice（活跃频道）', async () => {
    await mount('ch-1');
    expect(mockWuList).toHaveBeenCalledWith({ channelId: 'ch-1', limit: 100 });
    expect(mockReqList).toHaveBeenCalledWith({ channelId: 'ch-1' });
    expect(mockGetSuggestions).toHaveBeenCalledWith('ch-1');
    expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(1);
    expect(useChannelWorkStore.getState().suggestions['ch-1']?.resolved).toBe(true);
  });

  it('channelId undefined → 不打底不接线', async () => {
    renderHook(() => useChannelWorkStoreSync(undefined));
    await act(async () => {});
    expect(mockWuList).not.toHaveBeenCalled();
    expect(useChannelWorkStore.getState().wus).toEqual({});
  });
});

describe('useChannelWorkStoreSync — SSE 路由（只处理活跃频道）', () => {
  it('status_changed 本频道 → 全量快照直替 + 标脏建议防抖重拉', async () => {
    await mount('ch-1');
    vi.useFakeTimers();
    try {
      act(() => handler!({
        event_type: 'workunit.status_changed',
        data: { workunit: wuFixture('wu-1', { status: 'done', updatedAt: '2026-09-02T00:00:00Z' }) },
      }));
      expect(useChannelWorkStore.getState().wus['ch-1']![0].status).toBe('done');
      expect(useChannelWorkStore.getState().wus['ch-1']![0].updatedAt).toBe('2026-09-02T00:00:00Z');
      expect(mockGetSuggestions).toHaveBeenCalledTimes(1); // 仅挂载那次，防抖窗口内未重拉
      await act(async () => { await vi.advanceTimersByTimeAsync(SUGGESTIONS_RELOAD_DEBOUNCE_MS); });
      expect(mockGetSuggestions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('status_changed 非本频道 → no-op（不建 slice、不标脏）', async () => {
    await mount('ch-1');
    vi.useFakeTimers();
    try {
      act(() => handler!({
        event_type: 'workunit.status_changed',
        data: { workunit: wuFixture('wu-9', { channelId: 'ch-2' }) },
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(SUGGESTIONS_RELOAD_DEBOUNCE_MS); });
      expect(useChannelWorkStore.getState().wus['ch-2']).toBeUndefined();
      expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(1);
      expect(mockGetSuggestions).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requirement.created 本频道 → 就地 upsert + 标脏；channelId 不匹配的 REQ 事件跳过', async () => {
    await mount('ch-1');
    const reqPayload = { id: 'REQ-1', seq: 1, title: '需求一', status: 'open', channelId: 'ch-1', createdAt: '2026-09-01T00:00:00Z', createdBy: 'human' };
    act(() => handler!({ event_type: 'requirement.created', data: { requirement: reqPayload } }));
    expect(useChannelWorkStore.getState().reqs['ch-1']).toHaveLength(1);
    act(() => handler!({ event_type: 'requirement.created', data: { requirement: { ...reqPayload, id: 'REQ-2', channelId: 'ch-2' } } }));
    expect(useChannelWorkStore.getState().reqs['ch-1']).toHaveLength(1);
  });

  it('requirement.updated 本频道已有条目 → 全量覆盖（含 status 枚举校验外的合法状态）', async () => {
    mockReqList.mockResolvedValue({ data: { success: true, data: [
      { id: 'REQ-1', seq: 1, title: '旧', status: 'open', channelId: 'ch-1', createdAt: '2026-09-01T00:00:00Z', createdBy: 'human' },
    ] } });
    await mount('ch-1');
    act(() => handler!({
      event_type: 'requirement.updated',
      data: { requirement: { id: 'REQ-1', seq: 1, title: '新', status: 'done', channelId: 'ch-1', createdAt: '2026-09-01T00:00:00Z', createdBy: 'human' } },
    }));
    expect(useChannelWorkStore.getState().reqs['ch-1']![0].title).toBe('新');
  });

  it('channel.message_sent 本频道 → 标脏防抖重拉；非本频道/缺 channelId → no-op', async () => {
    await mount('ch-1');
    vi.useFakeTimers();
    try {
      act(() => handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-2' } }));
      act(() => handler!({ event_type: 'channel.message_sent', data: {} }));
      await act(async () => { await vi.advanceTimersByTimeAsync(SUGGESTIONS_RELOAD_DEBOUNCE_MS); });
      expect(mockGetSuggestions).toHaveBeenCalledTimes(1);
      act(() => handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1' } }));
      await act(async () => { await vi.advanceTimersByTimeAsync(SUGGESTIONS_RELOAD_DEBOUNCE_MS); });
      expect(mockGetSuggestions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('坏负载 no-op 不炸', async () => {
    await mount('ch-1');
    expect(() => {
      act(() => handler!({ event_type: 'workunit.status_changed', data: null }));
      act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: { status: 'done' } } }));
      act(() => handler!({ event_type: 'requirement.updated', data: { requirement: { id: 'REQ-1' } } }));
    }).not.toThrow();
    expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(1);
    expect(useChannelWorkStore.getState().reqs['ch-1']).toEqual([]);
  });
});

describe('useChannelWorkStoreSync — 重连对齐', () => {
  it('onReconnect → 全 slice 强刷（wus/reqs maxAgeMs:0 + suggestions 即时）', async () => {
    let reconnect: (() => void) | null = null;
    mockOnReconnect.mockImplementation((h: () => void) => { reconnect = h; return () => {}; });
    await mount('ch-1');
    expect(mockWuList).toHaveBeenCalledTimes(1);
    act(() => reconnect!());
    await vi.waitFor(() => {
      expect(mockWuList).toHaveBeenCalledTimes(2);
      expect(mockReqList).toHaveBeenCalledTimes(2);
      expect(mockGetSuggestions).toHaveBeenCalledTimes(2);
    });
  });
});
