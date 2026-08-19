// useImeEnterGuard — #270（决策 #248 D7）：IME 合成守卫单元测试。
// isComposing / keyCode 229 / compositionend 后 10ms 兜底三条判定路径直测；
// 组件级集成（composer / NEED_INPUT 回复框）见 ChannelInput-keyboard / ChannelMessageItem-inline 测试。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImeEnterGuard } from '../useImeEnterGuard';

function fakeKeyEvent(init: { isComposing?: boolean; keyCode?: number }) {
  return { nativeEvent: { isComposing: false, keyCode: 13, ...init } } as unknown as React.KeyboardEvent;
}

describe('useImeEnterGuard（#270）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isComposing 中的事件判为 IME 事件', () => {
    const { result } = renderHook(() => useImeEnterGuard());
    expect(result.current.isImeEvent(fakeKeyEvent({ isComposing: true }))).toBe(true);
  });

  it('keyCode 229 判为 IME 事件', () => {
    const { result } = renderHook(() => useImeEnterGuard());
    expect(result.current.isImeEvent(fakeKeyEvent({ keyCode: 229 }))).toBe(true);
  });

  it('普通 Enter（非合成、keyCode 13）不判为 IME 事件', () => {
    const { result } = renderHook(() => useImeEnterGuard());
    expect(result.current.isImeEvent(fakeKeyEvent({}))).toBe(false);
  });

  it('compositionend 后 10ms 内兜底判 IME 事件，之后恢复', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { result } = renderHook(() => useImeEnterGuard());

    act(() => result.current.handleCompositionEnd());

    nowSpy.mockReturnValue(1005);
    expect(result.current.isImeEvent(fakeKeyEvent({}))).toBe(true);

    nowSpy.mockReturnValue(1020);
    expect(result.current.isImeEvent(fakeKeyEvent({}))).toBe(false);
  });
});
