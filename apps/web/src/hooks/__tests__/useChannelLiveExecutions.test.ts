// useChannelLiveExecutions — #242 频道 live 状态条数据源：
// 初始 active 列表 + status_changed 增删 + execution.step 更新步号（推导在 execution-rows）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockOnEvent, mockList } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockList },
}));

import { useChannelLiveExecutions } from '../useChannelLiveExecutions';

const statusChanged = (id: string, status: string, channelId = 'ch-1', metadata = '{}') => ({
  event_type: 'workunit.status_changed',
  data: { workunit: { id, status, channelId, metadata } },
});
const stepEvent = (workUnitId: string, step: number, action?: string) => ({
  event_type: 'workunit.execution.step',
  data: { workUnitId, step, ...(action ? { action } : {}) },
});

describe('useChannelLiveExecutions', () => {
  let handler: ((m: unknown) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    mockOnEvent.mockImplementation((h: (m: unknown) => void) => { handler = h; return () => {}; });
    mockList.mockResolvedValue({ data: { data: [] } });
  });

  it('初始拉取本频道 active WU（步号回退 metadata.stepCount）', async () => {
    mockList.mockResolvedValue({ data: { data: [{ id: 'WU-1', metadata: JSON.stringify({ stepCount: 2 }) }] } });
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 2 }]));
    expect(mockList).toHaveBeenCalledWith({ channelId: 'ch-1', status: 'active', limit: 100 });
  });

  it('status_changed：active 加入、终态移出；他频道忽略', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(statusChanged('WU-1', 'active', 'ch-1', JSON.stringify({ stepCount: 1 }))); });
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 1 }]);
    act(() => { handler!(statusChanged('WU-9', 'active', 'ch-other')); });
    expect(result.current).toHaveLength(1);
    act(() => { handler!(statusChanged('WU-1', 'done')); });
    expect(result.current).toEqual([]);
  });

  it('execution.step 事件更新步号（SSE 优先于 metadata）', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(statusChanged('WU-1', 'active', 'ch-1', JSON.stringify({ stepCount: 1 }))); });
    act(() => { handler!(stepEvent('WU-1', 4, 'progress')); });
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 4, action: 'progress' }]);
  });

  it('channelId 切换 → 清空重拉', async () => {
    const { result, rerender } = renderHook(({ id }) => useChannelLiveExecutions(id), { initialProps: { id: 'ch-1' as string | null } });
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(statusChanged('WU-1', 'active')); });
    expect(result.current).toHaveLength(1);
    rerender({ id: 'ch-2' });
    expect(result.current).toEqual([]);
  });

  it('channelId 为 null → 不拉取不订阅', () => {
    const { result } = renderHook(() => useChannelLiveExecutions(null));
    expect(result.current).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockOnEvent).not.toHaveBeenCalled();
  });
});
