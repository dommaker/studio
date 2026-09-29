// useChannelLiveExecutions — #242 频道 live 状态条数据源
// B3（2026-09 频道前端效率批）：active 集从 channelWorkStore.wus 派生（不再独立 REST 打底），
// 本 hook 只剩 step 事件簿记（含等值守卫/频道过滤/终态清理）；推导在 execution-rows
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
import { useChannelWorkStore } from '../../stores/channelWorkStore';
import type { WorkUnit } from '../../api/workunit';

const wuRow = (id: string, over: Partial<WorkUnit> = {}): WorkUnit => ({
  id, parentId: null, dependsOn: '', type: 'task', scope: `任务${id}`,
  assigneeId: null, status: 'active', failureType: null, retryCount: 0,
  timeoutAt: null, channelId: 'ch-1', metadata: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  claimedAt: null, completedAt: null,
  ...over,
});

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
    useChannelWorkStore.getState().__resetForTests();
    mockOnEvent.mockImplementation((h: (m: unknown) => void) => { handler = h; return () => {}; });
    mockList.mockResolvedValue({ data: { data: [] } });
  });

  it('active 集从 channelWorkStore.wus 派生（步号回退 metadata.stepCount）；不再发 status=active 查询', async () => {
    mockList.mockResolvedValue({ data: { data: [
      wuRow('WU-1', { metadata: JSON.stringify({ stepCount: 2 }) }),
      wuRow('WU-2', { status: 'done' }),
    ] } });
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 2 }]));
    // 唯一查询 = store 的全集打底（无 status 参数），不再有独立的 active 查询
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith({ channelId: 'ch-1', limit: 100 });
  });

  it('store 快照落库驱动增删（active 出现、终态移出）；他频道 snapshot 不进本频道集', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1',
      wuRow('WU-1', { metadata: JSON.stringify({ stepCount: 1 }) })));
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 1 }]);
    act(() => useChannelWorkStore.getState().applyWorkunitSnapshot('ch-other', wuRow('WU-9', { channelId: 'ch-other' })));
    expect(result.current).toHaveLength(1);
    act(() => useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', wuRow('WU-1', { status: 'done' })));
    expect(result.current).toEqual([]);
  });

  it('execution.step 事件更新步号（SSE 优先于 metadata）', async () => {
    mockList.mockResolvedValue({ data: { data: [wuRow('WU-1', { metadata: JSON.stringify({ stepCount: 1 }) })] } });
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => { handler!(stepEvent('WU-1', 4, 'progress')); });
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 4, action: 'progress' }]);
  });

  // SSE 负载深化（决策 4）：step 负载带 channelId 时按频道过滤；缺省（旧后端）不过滤
  it('他频道 step 事件（带 channelId）被过滤，不进步索引', async () => {
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    act(() => { handler!(stepEvent('WU-9', 9, undefined, 'ch-other')); });
    // WU-9 后转入本频道：若他频道步未被过滤，步号会错显 9 而非 metadata.stepCount
    act(() => useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1',
      wuRow('WU-9', { metadata: JSON.stringify({ stepCount: 1 }) })));
    expect(result.current).toEqual([{ workUnitId: 'WU-9', step: 1 }]);
  });

  it('本频道 step 事件（带 channelId）正常进步索引', async () => {
    mockList.mockResolvedValue({ data: { data: [wuRow('WU-1')] } });
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => { handler!(stepEvent('WU-1', 5, undefined, 'ch-1')); });
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 5 }]);
  });

  it('step 事件缺 channelId（旧后端）→ 不过滤，保持现状行为', async () => {
    mockList.mockResolvedValue({ data: { data: [wuRow('WU-1')] } });
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
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
    act(() => useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1',
      wuRow('WU-9', { metadata: JSON.stringify({ stepCount: 2 }) })));
    expect(result.current).toEqual([{ workUnitId: 'WU-9', step: 2 }]); // 残留未清会错显 9
  });

  // F3 等值守卫：同 wuId 内容等值的 step 事件不再触发 setState（无新渲染，返回引用不变）
  it('等值 step 事件跳过 setState（结果引用不变）；变化事件仍生效', async () => {
    mockList.mockResolvedValue({ data: { data: [wuRow('WU-1')] } });
    const { result } = renderHook(() => useChannelLiveExecutions('ch-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => { handler!(stepEvent('WU-1', 5, 'progress')); });
    const before = result.current;
    act(() => { handler!(stepEvent('WU-1', 5, 'progress')); }); // step+action 全等值
    expect(result.current).toBe(before);
    act(() => { handler!(stepEvent('WU-1', 6, 'progress')); }); // step 变化
    expect(result.current).toEqual([{ workUnitId: 'WU-1', step: 6, action: 'progress' }]);
  });

  it('channelId 切换 → 步索引清空，live 集跟随新频道 slice', async () => {
    mockList.mockImplementation(({ channelId }: { channelId: string }) => Promise.resolve({
      data: { data: channelId === 'ch-1' ? [wuRow('WU-1')] : [] },
    }));
    const { result, rerender } = renderHook(({ id }) => useChannelLiveExecutions(id), { initialProps: { id: 'ch-1' as string | null } });
    await waitFor(() => expect(result.current).toHaveLength(1));
    rerender({ id: 'ch-2' });
    expect(result.current).toEqual([]);
    await act(async () => {}); // ch-2 打底落库（空集），防 act 外异步更新告警
  });

  it('channelId 为 null → 不拉取不订阅', () => {
    const { result } = renderHook(() => useChannelLiveExecutions(null));
    expect(result.current).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockOnEvent).not.toHaveBeenCalled();
  });
});
