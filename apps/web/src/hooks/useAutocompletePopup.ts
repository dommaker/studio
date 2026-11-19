// useAutocompletePopup（#691，docs/plans/2026-10-arch-simplification.md Phase 2-2）：
// ChannelInput @/# 两套同构补全弹框合一的通用状态机——触发解析（parseTriggerAt 纯函数）、
// 候选分组（getGroups 注入过滤/渲染逻辑）、Esc dismiss（#270 语义：继续输入经 resetDismiss
// 复位，弹框不由残留 query 推导重开）、键盘导航（↑↓ 循环 / Enter·Tab 选中 / Esc 关闭）、
// 选中插入（触发位替换文本 + 光标置插入串尾 + focus）。
// 互斥（@/# 同时命中取起点靠后者）由调用方用两次 parseTriggerAt 结果推导，经 active 传入。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

/** 触发解析结果：start = 触发符下标，query = 触发符到光标间的文本 */
export interface TriggerState {
  start: number;
  query: string;
}

/** 光标前最后一个 trigger 的补全触发态；query 含空格/换行（补全已结束）或无触发符 → null */
export function parseTriggerAt(content: string, cursorPos: number, trigger: string): TriggerState | null {
  const pos = Math.min(cursorPos, content.length);
  const before = content.slice(0, pos);
  const lastAt = before.lastIndexOf(trigger);
  if (lastAt === -1) return null;
  const query = before.slice(lastAt + 1);
  if (query.includes(' ') || query.includes('\n')) return null;
  return { start: lastAt, query };
}

/** 单个候选：insertText = 触发位起的完整替换文本（含触发符/路径与尾随空格）；data = 渲染负载 */
export interface AutocompleteItem<T> {
  key: string;
  insertText: string;
  data: T;
  /** 选中副作用（如文件引用台账登记） */
  onPicked?: () => void;
}

/** 候选分组：label 非空且组内有候选时渲染组头；renderItem 由注入方按组内负载类型定义 */
export interface AutocompleteGroup<T> {
  label: string | null;
  items: AutocompleteItem<T>[];
  renderItem: (item: AutocompleteItem<T>) => ReactNode;
}

export interface UseAutocompletePopupOptions<T> {
  /** parseTriggerAt 结果（调用方持有，供互斥推导/候选懒加载等副作用复用） */
  triggerState: TriggerState | null;
  /** 互斥裁决：另一弹框起点更贴近光标时本弹框 false */
  active: boolean;
  /** 过滤逻辑注入：query → 候选分组；仅弹框激活时调用 */
  getGroups: (query: string) => AutocompleteGroup<T>[];
  content: string;
  cursorPos: number;
  /** 写入新内容与光标位（state 更新）；DOM 光标定位/focus 由本 hook 承担 */
  applyEdit: (content: string, cursorPos: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export interface AutocompletePopupController<T> {
  groups: AutocompleteGroup<T>[];
  /** 跨组拍平的候选（activeIdx 序号空间） */
  items: AutocompleteItem<T>[];
  open: boolean;
  activeIdx: number;
  activeItemRef: RefObject<HTMLButtonElement | null>;
  pick: (item: AutocompleteItem<T>) => void;
  /** 弹框键盘导航；返回 true = 事件已消费 */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** 继续输入/外部填入表达新意图：复位 Esc dismiss */
  resetDismiss: () => void;
  /** 序号归零 + dismiss 复位（插入片段路径） */
  resetSelection: () => void;
}

export function useAutocompletePopup<T>(opts: UseAutocompletePopupOptions<T>): AutocompletePopupController<T> {
  const { triggerState, active, getGroups, content, cursorPos, applyEdit, textareaRef } = opts;
  const [idx, setIdx] = useState(0);
  // #270：Esc dismiss——记录被关掉的触发起点；继续输入（resetDismiss）表达新意图后重开
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  const groups = useMemo(
    () => (active && triggerState ? getGroups(triggerState.query) : []),
    [active, triggerState, getGroups],
  );
  const items = useMemo(() => groups.flatMap(g => g.items), [groups]);
  // 弹框可见性 = 有候选 且 未被 Esc dismiss（不由残留 query 单独推导）
  const open = active && items.length > 0 && dismissedAt !== triggerState?.start;
  // 跨组统一序号；query 变化致候选收缩时钳位选中项
  const activeIdx = items.length > 0 ? idx % items.length : 0;

  // #270：弹框轻量重绘——选中项滚动进可视区（jsdom 无 scrollIntoView，?. 兜底）
  useEffect(() => {
    if (open) activeItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx, open]);

  const pick = useCallback((item: AutocompleteItem<T>) => {
    if (!triggerState) return;
    const pos = Math.min(cursorPos, content.length);
    const newContent = `${content.slice(0, triggerState.start)}${item.insertText}${content.slice(pos)}`;
    const newCursor = triggerState.start + item.insertText.length;
    applyEdit(newContent, newCursor);
    setIdx(0);
    item.onPicked?.();
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [triggerState, content, cursorPos, applyEdit, textareaRef]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx(prev => (prev + 1) % items.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx(prev => (prev - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(items[activeIdx]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // #270：真正关闭弹框（dismiss 状态），与「Esc 取消」提示一致
      setDismissedAt(triggerState?.start ?? null);
      setIdx(0);
      return true;
    }
    return false;
  }, [open, items, activeIdx, pick, triggerState]);

  const resetDismiss = useCallback(() => setDismissedAt(null), []);
  const resetSelection = useCallback(() => {
    setIdx(0);
    setDismissedAt(null);
  }, []);

  return { groups, items, open, activeIdx, activeItemRef, pick, handleKeyDown, resetDismiss, resetSelection };
}
