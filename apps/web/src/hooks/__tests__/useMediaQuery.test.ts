// useMediaQuery — #395 窄屏降级的 JS 断点桥：matchMedia 包装 hook
// 覆盖：matchMedia 缺失（jsdom/老环境）回落默认值 / 命中与不命中 / change 事件驱动更新 / 卸载解订阅
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '../useMediaQuery';
import { mockMatchMedia, uninstallMatchMedia } from '../../test/mockMatchMedia';

describe('useMediaQuery', () => {
  afterEach(() => uninstallMatchMedia());

  it('matchMedia 不可用时回落 defaultMatches（宽屏语义：min-width true / max-width false）', () => {
    // jsdom 默认无 matchMedia
    const { result: min } = renderHook(() => useMediaQuery('(min-width: 1024px)', true));
    expect(min.result.current).toBe(true);
    const { result: max } = renderHook(() => useMediaQuery('(max-width: 767px)', false));
    expect(max.result.current).toBe(false);
  });

  it('按视口宽度求值：宽屏命中 min-width，窄屏命中 max-width', () => {
    mockMatchMedia(1280);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)', true));
    expect(result.current).toBe(true);
    uninstallMatchMedia();
    mockMatchMedia(700);
    const { result: narrow } = renderHook(() => useMediaQuery('(max-width: 767px)', false));
    expect(narrow.result.current).toBe(true);
  });

  it('setWidth 跨过断点 → change 事件驱动重算', () => {
    const { setWidth } = mockMatchMedia(1280);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)', true));
    expect(result.current).toBe(true);
    act(() => setWidth(700));
    expect(result.current).toBe(false);
    act(() => setWidth(800));
    expect(result.current).toBe(true);
  });

  it('卸载后解订阅：setWidth 不再触发更新', () => {
    const { setWidth } = mockMatchMedia(1280);
    const { result, unmount } = renderHook(() => useMediaQuery('(min-width: 768px)', true));
    unmount();
    act(() => setWidth(700));
    expect(result.current).toBe(true);
  });
});
