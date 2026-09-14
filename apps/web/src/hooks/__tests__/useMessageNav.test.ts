// useMessageNav — 消息级键盘导航 hook 单测（channel 上下游优化 Phase 3 AC5）。
// 页面装配行为（焦点环类、replyTo 预览、composer 聚焦）见
// pages/__tests__/ChannelDetailPage-kb-nav.test.tsx；此处覆盖 hook 状态机分支。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useMessageNav } from '../useMessageNav';

const IDS = ['m1', 'm2', 'm3'];

const setup = (over: Partial<Parameters<typeof useMessageNav>[0]> = {}) => {
  const onReply = vi.fn();
  const onCancelReply = vi.fn();
  const onFocusScroll = vi.fn();
  const hook = renderHook((props: Parameters<typeof useMessageNav>[0]) => useMessageNav(props), {
    initialProps: {
      navIds: IDS,
      onReply,
      hasReplyTo: false,
      onCancelReply,
      onFocusScroll,
      ...over,
    },
  });
  return { hook, onReply, onCancelReply, onFocusScroll };
};

const key = (k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: k, ...init });

describe('useMessageNav（Phase 3 / AC5）', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('j/k 维护 focusedId：无焦点 j→首条 k→末条；边界停住不环绕', () => {
    const { hook } = setup();
    act(() => key('j'));
    expect(hook.result.current.focusedId).toBe('m1');
    act(() => key('k')); // 首条再向上 → 停住
    expect(hook.result.current.focusedId).toBe('m1');
    act(() => key('j'));
    act(() => key('j'));
    act(() => key('j')); // 末条再向下 → 停住
    expect(hook.result.current.focusedId).toBe('m3');

    // 无焦点时 k → 末条
    const { hook: h2 } = setup();
    act(() => key('k'));
    expect(h2.result.current.focusedId).toBe('m3');
  });

  it('焦点迁移触发 onFocusScroll 回调（滚动跟随交页面）', () => {
    const { onFocusScroll } = setup();
    act(() => key('j'));
    expect(onFocusScroll).toHaveBeenCalledWith('m1');
  });

  it('r 对焦点消息触发 onReply；无焦点不触发', () => {
    const { onReply } = setup();
    act(() => key('r'));
    expect(onReply).not.toHaveBeenCalled();
    act(() => key('j'));
    act(() => key('j'));
    act(() => key('r'));
    expect(onReply).toHaveBeenCalledWith('m2');
  });

  it('Esc 优先取消 replyTo（不动焦点）；无 replyTo 时清焦点', () => {
    const onCancelReply = vi.fn();
    const { result, rerender } = renderHook(
      (p: { hasReplyTo: boolean }) => useMessageNav({
        navIds: IDS, onReply: vi.fn(), hasReplyTo: p.hasReplyTo, onCancelReply, onFocusScroll: vi.fn(),
      }),
      { initialProps: { hasReplyTo: true } },
    );
    act(() => key('j'));
    act(() => key('Escape'));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(result.current.focusedId).toBe('m1'); // 焦点保留

    rerender({ hasReplyTo: false });
    act(() => key('Escape'));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(result.current.focusedId).toBeNull();
  });

  it('editable target（input/textarea/contenteditable）不响应 j/k/r；Esc 仍生效', () => {
    const { hook, onReply, onCancelReply } = setup({ hasReplyTo: true });
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    act(() => { key('j', input); key('k', input); key('r', input); });
    expect(hook.result.current.focusedId).toBeNull();
    expect(onReply).not.toHaveBeenCalled();
    act(() => key('Escape', input));
    expect(onCancelReply).toHaveBeenCalled();
  });

  it('已 preventDefault 的 Esc（mention 弹框消费）不抢', () => {
    const { onCancelReply } = setup({ hasReplyTo: true });
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', e => e.preventDefault()); // 模拟 ChannelInput 弹框消费
    act(() => key('Escape', el));
    expect(onCancelReply).not.toHaveBeenCalled();
  });

  it('修饰键组合（Ctrl/Meta/Alt + j）不触发导航', () => {
    const { hook } = setup();
    act(() => key('j', document.body, { ctrlKey: true }));
    act(() => key('j', document.body, { metaKey: true }));
    expect(hook.result.current.focusedId).toBeNull();
  });

  it('navIds 变化后焦点掉出列表 → 派生为 null（j 重新从首条开始）', () => {
    const { hook } = setup();
    act(() => key('j'));
    act(() => key('j'));
    expect(hook.result.current.focusedId).toBe('m2');
    hook.rerender({ navIds: ['m3', 'm4'], onReply: vi.fn(), hasReplyTo: false, onCancelReply: vi.fn(), onFocusScroll: vi.fn() });
    expect(hook.result.current.focusedId).toBeNull();
    act(() => key('j'));
    expect(hook.result.current.focusedId).toBe('m3');
  });

  it('navIds 为空 → j/k 不置焦点', () => {
    const { hook } = setup({ navIds: [] });
    act(() => key('j'));
    expect(hook.result.current.focusedId).toBeNull();
  });
});
