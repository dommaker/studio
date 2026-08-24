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
const stepEvent = (workUnitId: string, step: number, action?: string, channelId?: string) => ({
  event_type: 'workunit.execution.step',
  data: { workUnitId, step, ...(action ? { action } : {}), ...(channelId ? { channelId } : {}) },
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

  // SSE 负载深化（决策 4）：step 负载带 channelId 时按频道过滤；缺省（旧后端）不过滤
  it('他频道 step 事件（带 channelId）被过滤，不进步索引', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(stepEvent('WU-9', 9, undefined, 'ch-other')); });
    // WU-9 后转入本频道：若他频道步未被过滤，步号会错显 9 而非 metadata.stepCount
    act(() => { handler!(statusChanged('WU-9', 'active', 'ch-1', JSON.stringify({ stepCount: 1 }))); });
    expect(result.current).toEqual([{ workUnitId: 'WU-9', step: 1 }]);
  });

  it('本频道 step 事件（带 channelId）正常进步索引', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(statusChanged('WU-1', 'active', 'ch-1')); });
    act(() => { handler!(stepEvent('WU-1', 5, undefined, 'ch-1')); });
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 5 }]);
  });

  it('step 事件缺 channelId（旧后端）→ 不过滤，保持现状行为', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(statusChanged('WU-1', 'active', 'ch-1')); });
    act(() => { handler!(stepEvent('WU-1', 6)); });
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 6 }]);
  });

  // 内存残留修复：缺 channelId 的他频道 step 条目会进入 steps；其终态 status_changed
  // 若被频道早退挡住则条目永不清理。终态清理须不限频道。
  it('他频道 WU 终态 status_changed → 其（未过滤进入的）step 条目一并清理', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(stepEvent('WU-9', 9)); }); // 缺 channelId，向后兼容路径进入 steps
    act(() => { handler!(statusChanged('WU-9', 'done', 'ch-other')); }); // 他频道终态 → 清理残留
    act(() => { handler!(statusChanged('WU-9', 'active', 'ch-1', JSON.stringify({ stepCount: 2 }))); });
    expect(result.current).toEqual([{ workUnitId: 'WU-9', step: 2 }]); // 残留未清会错显 9
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
