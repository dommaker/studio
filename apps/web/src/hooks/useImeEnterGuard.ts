// #270（决策 #248 D7，dsh 同款）：IME 合成守卫，composer 与 NEED_INPUT 内嵌回复框共用。
// isComposing / keyCode 229 之外，compositionend 后 10ms 内的 Enter 也视为选词确认——
// 部分 IME 在 keydown Enter 之前先派 compositionend，仅看 isComposing 会漏。
import { useCallback, useRef } from 'react';

export function useImeEnterGuard() {
  const lastCompositionEndRef = useRef(0);

  const handleCompositionEnd = useCallback(() => {
    lastCompositionEndRef.current = Date.now();
  }, []);

  /** 该键盘事件是否处于 IME 合成（选词）过程中 —— 是则 Enter 不得触发发送/确认 */
  const isImeEvent = useCallback((e: React.KeyboardEvent) => {
    const native = e.nativeEvent as KeyboardEvent;
    return (
      native.isComposing ||
      native.keyCode === 229 ||
      Date.now() - lastCompositionEndRef.current < 10
    );
  }, []);

  return { handleCompositionEnd, isImeEvent };
}
