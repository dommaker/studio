// useGlobalShortcuts 单测（批次 D-2 项 8）：唤起键匹配 / 修饰键口径 / 输入聚焦守卫 / 卸载清理 / 注册表热更新
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGlobalShortcuts, type GlobalShortcut } from '../useGlobalShortcuts';

const press = (key: string, init: KeyboardEventInit = {}, target?: HTMLElement) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (target ?? document).dispatchEvent(e);
  return e;
};

describe('useGlobalShortcuts', () => {
  it('mod+k：metaKey 与 ctrlKey 均命中（mac Cmd / 其他 Ctrl 统一口径）', () => {
    const handler = vi.fn();
    renderHook(() => useGlobalShortcuts([{ key: 'k', mod: true, allowInInput: true, handler }]));
    press('k', { metaKey: true });
    press('k', { ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('缺修饰键/多 Shift 不匹配；匹配即 preventDefault', () => {
    const handler = vi.fn();
    renderHook(() => useGlobalShortcuts([{ key: 'k', mod: true, allowInInput: true, handler }]));
    press('k');
    expect(handler).not.toHaveBeenCalled();
    press('k', { metaKey: true, shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
    const e = press('k', { metaKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('输入框聚焦守卫：非唤起类不触发，allowInInput 唤起类照触发', () => {
    const nav = vi.fn();
    const invoke = vi.fn();
    const shortcuts: GlobalShortcut[] = [
      { key: 'c', handler: nav }, // 导航类（后续 g c/g p 同位）
      { key: 'k', mod: true, allowInInput: true, handler: invoke },
    ];
    renderHook(() => useGlobalShortcuts(shortcuts));
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('c', {}, input);
    expect(nav).not.toHaveBeenCalled();
    press('k', { metaKey: true }, input);
    expect(invoke).toHaveBeenCalledTimes(1);
    // 非输入目标上导航类正常触发
    press('c');
    expect(nav).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('卸载移除 listener；注册表渲染期热更新（无需重挂）', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ handler }: { handler: (e: KeyboardEvent) => void }) =>
        useGlobalShortcuts([{ key: 'k', mod: true, allowInInput: true, handler }]),
      { initialProps: { handler: first } },
    );
    rerender({ handler: second });
    press('k', { metaKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    press('k', { metaKey: true });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('首个命中即消费：注册序为优先级', () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() =>
      useGlobalShortcuts([
        { key: 'k', mod: true, allowInInput: true, handler: a },
        { key: 'k', mod: true, allowInInput: true, handler: b },
      ]),
    );
    press('k', { metaKey: true });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});
