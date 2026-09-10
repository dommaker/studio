// useGlobalShortcuts — 全局快捷键注册底座（批次 D-2 项 8，docs/plans/2026-09-ui-interaction-polish.md）。
// 当前唯一消费方：App 根注册 Cmd/Ctrl+K 唤起/关闭 CommandPalette；后续批次（g c/g p 导航）
// 追加注册项即可，注册位结构 = GlobalShortcut[]。
// 守卫：焦点在 input/textarea/contentEditable 时，非唤起类快捷键（allowInInput 缺省 false）
// 一律不触发——导航类快捷键不得劫持文本输入；唤起键（⌘K）是唤起不是输入，显式 allowInInput: true。
import { useEffect, useRef } from 'react';

export interface GlobalShortcut {
  /** KeyboardEvent.key（大小写不敏感），如 'k' */
  key: string;
  /** true = 需要 Cmd(mac)/Ctrl(其他)（metaKey || ctrlKey 任一） */
  mod?: boolean;
  /** true = 需要 Shift；缺省 false = 按了 Shift 反而不匹配 */
  shift?: boolean;
  /** 唤起类快捷键 = true（输入框聚焦也触发）；导航类缺省 false（输入聚焦时不触发） */
  allowInInput?: boolean;
  handler: (e: KeyboardEvent) => void;
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

export function useGlobalShortcuts(shortcuts: readonly GlobalShortcut[]): void {
  // 镜像 ref：调用方每次渲染新建数组也不用重挂 listener（同 useChannelCardActions 模式）；
  // ref 写入放 effect（render 期写 ref 触发 react-hooks/refs 警告），每次渲染后同步
  const ref = useRef(shortcuts);
  useEffect(() => {
    ref.current = shortcuts;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const s of ref.current) {
        if (e.key.toLowerCase() !== s.key.toLowerCase()) continue;
        if ((e.metaKey || e.ctrlKey) !== !!s.mod) continue;
        if (e.shiftKey !== !!s.shift) continue;
        if (isEditableTarget(e.target) && !s.allowInInput) continue;
        e.preventDefault();
        s.handler(e);
        return; // 首个命中即消费，注册序 = 优先级
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
