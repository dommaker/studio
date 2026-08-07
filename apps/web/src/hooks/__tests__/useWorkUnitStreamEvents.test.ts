// useWorkUnitStreamEvents — Layer B 步内流式 chunk 订阅（SSE-only，内存态，只留当前步）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api/websocket', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

import { useWorkUnitStreamEvents } from '../useWorkUnitStreamEvents';

/** 造一条 stream SSE 消息（dataOverrides 覆盖 data 字段） */
const msg = (dataOver: Record<string, unknown> = {}) => ({
  event_type: 'workunit.execution.stream',
  data: {
    workUnitId: 'wu-1', executionId: 'e1', step: 1, kind: 'text',
    text: 'hello', at: '2026-07-30T00:00:00Z',
    ...dataOver,
  },
});

describe('useWorkUnitStreamEvents', () => {
  let handler: ((m: unknown) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    mockOnEvent.mockImplementation((h: (m: unknown) => void) => { handler = h; return () => {}; });
  });

  it('收到本 WU 的 chunk → 累积；其他 WU / 其他事件类型 / 损坏行跳过', () => {
    const { result } = renderHook(() => useWorkUnitStreamEvents('wu-1'));
    act(() => {
      handler!(msg());
      handler!(msg({ workUnitId: 'wu-2', text: '别的' }));
      handler!({ event_type: 'workunit.execution.step', data: { workUnitId: 'wu-1' } });
      handler!({ event_type: 'workunit.execution.stream', data: '{broken' });
      handler!(msg({ kind: 'tool', tool: 'Bash', summary: 'pnpm test', at: '2026-07-30T00:00:01Z' }));
    });
    expect(result.current).toHaveLength(2);
    expect(result.current[0].kind).toBe('text');
    expect(result.current[1]).toMatchObject({ kind: 'tool', tool: 'Bash' });
  });

  it('新一步 step-start → 清空上一步残留', () => {
    const { result } = renderHook(() => useWorkUnitStreamEvents('wu-1'));
    act(() => {
      handler!(msg({ kind: 'step-start', at: 't0' }));
      handler!(msg({ kind: 'thinking', text: '想', at: 't1' }));
    });
    expect(result.current).toHaveLength(2);
    act(() => {
      handler!(msg({ executionId: 'e2', step: 2, kind: 'step-start', at: 't2' }));
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ step: 2, kind: 'step-start' });
  });

  it('超过 50 条丢最旧（容量纪律）', () => {
    const { result } = renderHook(() => useWorkUnitStreamEvents('wu-1'));
    act(() => {
      for (let i = 0; i < 60; i++) {
        handler!(msg({ text: `m${i}`, at: `t${i}` }));
      }
    });
    expect(result.current).toHaveLength(50);
    expect(result.current[0].text).toBe('m10');
    expect(result.current[49].text).toBe('m59');
  });

  it('workUnitId 切换 → 清空重订', () => {
    const { result, rerender } = renderHook(({ id }) => useWorkUnitStreamEvents(id), { initialProps: { id: 'wu-1' } });
    act(() => { handler!(msg()); });
    expect(result.current).toHaveLength(1);
    rerender({ id: 'wu-2' });
    expect(result.current).toHaveLength(0);
    // 重订后旧 WU 的 chunk 不再进入
    act(() => { handler!(msg()); });
    expect(result.current).toHaveLength(0);
  });
});
