// usePersistentStreamUI — 频道折叠 UI 状态按频道持久化（2026-09 UI smoothness Step 3）
// 覆盖：默认值 / 读写往返 / 损坏 JSON 与缺字段回退 / 按频道隔离 / 频道切换加载
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistentStreamUI } from '../usePersistentStreamUI';

const key = (ch: string) => `mc-stream-ui:v1:${ch}`;

describe('usePersistentStreamUI', () => {
  beforeEach(() => window.localStorage.clear());

  it('无存档 → 默认值（showCompleted=false，三集合为空）', () => {
    const { result } = renderHook(() => usePersistentStreamUI('ch-1'));
    expect(result.current.showCompleted).toBe(false);
    expect(result.current.collapsedThreads.size).toBe(0);
    expect(result.current.expandedProcGroups.size).toBe(0);
    expect(result.current.expandedAlertGroups.size).toBe(0);
  });

  it('读写往返：setter 变更落 localStorage；卸载重挂后恢复', () => {
    const { result, unmount } = renderHook(() => usePersistentStreamUI('ch-1'));
    act(() => result.current.setShowCompleted(true));
    act(() => result.current.setCollapsedThreads(prev => new Set(prev).add('t1')));
    act(() => result.current.setExpandedProcGroups(prev => new Set(prev).add('proc-x')));
    act(() => result.current.setExpandedAlertGroups(prev => new Set(prev).add('alerts-a1')));
    expect(JSON.parse(window.localStorage.getItem(key('ch-1'))!)).toEqual({
      showCompleted: true, collapsedThreads: ['t1'], expandedProcGroups: ['proc-x'], expandedAlertGroups: ['alerts-a1'],
    });

    unmount();
    const again = renderHook(() => usePersistentStreamUI('ch-1'));
    expect(again.result.current.showCompleted).toBe(true);
    expect([...again.result.current.collapsedThreads]).toEqual(['t1']);
    expect([...again.result.current.expandedProcGroups]).toEqual(['proc-x']);
    expect([...again.result.current.expandedAlertGroups]).toEqual(['alerts-a1']);
  });

  it('setter 支持直值与 updater 两种形态（与 useState 语义对齐）', () => {
    const { result } = renderHook(() => usePersistentStreamUI('ch-1'));
    act(() => result.current.setShowCompleted(prev => !prev));
    expect(result.current.showCompleted).toBe(true);
    act(() => result.current.setCollapsedThreads(new Set(['a', 'b'])));
    expect([...result.current.collapsedThreads].sort()).toEqual(['a', 'b']);
  });

  it('损坏 JSON 静默回退默认值', () => {
    window.localStorage.setItem(key('ch-1'), '{oops');
    const { result } = renderHook(() => usePersistentStreamUI('ch-1'));
    expect(result.current.showCompleted).toBe(false);
    expect(result.current.collapsedThreads.size).toBe(0);
    expect(result.current.expandedProcGroups.size).toBe(0);
    expect(result.current.expandedAlertGroups.size).toBe(0);
  });

  it('缺字段按字段回退默认值（部分存档仍生效）；数组内非字符串条目丢弃', () => {
    window.localStorage.setItem(key('ch-1'), JSON.stringify({ collapsedThreads: ['t9', 7] }));
    const { result } = renderHook(() => usePersistentStreamUI('ch-1'));
    expect(result.current.showCompleted).toBe(false);
    expect([...result.current.collapsedThreads]).toEqual(['t9']);
    expect(result.current.expandedProcGroups.size).toBe(0);
  });

  it('#channel-ux P3 向后兼容：旧存档无 expandedAlertGroups 字段 → 默认空集，不炸解析', () => {
    window.localStorage.setItem(key('ch-1'),
      JSON.stringify({ showCompleted: true, collapsedThreads: [], expandedProcGroups: ['proc-1'] }));
    const { result } = renderHook(() => usePersistentStreamUI('ch-1'));
    expect(result.current.showCompleted).toBe(true);
    expect([...result.current.expandedProcGroups]).toEqual(['proc-1']);
    expect(result.current.expandedAlertGroups.size).toBe(0);
  });

  it('按频道隔离：ch-1 的存档不影响 ch-2', () => {
    window.localStorage.setItem(key('ch-1'),
      JSON.stringify({ showCompleted: true, collapsedThreads: ['t1'], expandedProcGroups: [] }));
    const { result } = renderHook(() => usePersistentStreamUI('ch-2'));
    expect(result.current.showCompleted).toBe(false);
    expect(result.current.collapsedThreads.size).toBe(0);
  });

  it('切换频道加载对应频道存档；新频道的变更写自己的 key', () => {
    window.localStorage.setItem(key('ch-2'),
      JSON.stringify({ showCompleted: true, collapsedThreads: ['x'], expandedProcGroups: [] }));
    const { result, rerender } = renderHook(
      ({ ch }: { ch: string }) => usePersistentStreamUI(ch),
      { initialProps: { ch: 'ch-1' } },
    );
    expect(result.current.showCompleted).toBe(false);

    rerender({ ch: 'ch-2' });
    expect(result.current.showCompleted).toBe(true);
    expect([...result.current.collapsedThreads]).toEqual(['x']);

    act(() => result.current.setShowCompleted(false));
    expect(JSON.parse(window.localStorage.getItem(key('ch-2'))!).showCompleted).toBe(false);
    // ch-1 的 key 只有挂载时的默认值直写，未被 ch-2 的状态污染
    expect(JSON.parse(window.localStorage.getItem(key('ch-1'))!)).toEqual({
      showCompleted: false, collapsedThreads: [], expandedProcGroups: [], expandedAlertGroups: [],
    });
  });
});
