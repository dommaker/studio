// useAutocompletePopup（#691，自 ChannelInput @/# 两套同构弹框合一抽出的通用状态机）：
// parseTriggerAt 触发解析 / 弹框开合（候选 + #270 Esc dismiss 语义）/ 键盘导航
// （↑↓ 循环、Enter·Tab 选中、Esc 关闭）/ 选中插入（触发位替换文本 + 光标定位）。
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createRef } from 'react';
import type { RefObject } from 'react';
import { parseTriggerAt, useAutocompletePopup } from '../useAutocompletePopup';
import type { AutocompleteGroup } from '../useAutocompletePopup';

interface Item {
  label: string;
}

const keyEvent = (key: string) =>
  ({ key, preventDefault: vi.fn() }) as unknown as React.KeyboardEvent;

function setup(opts: {
  content: string;
  cursorPos?: number;
  trigger?: string;
  active?: boolean;
  groups?: AutocompleteGroup<Item>[];
}) {
  const content = opts.content;
  const cursorPos = opts.cursorPos ?? content.length;
  const trigger = opts.trigger ?? '@';
  const applyEdit = vi.fn();
  const textareaRef = createRef<HTMLTextAreaElement>() as RefObject<HTMLTextAreaElement | null>;
  const groups = opts.groups ?? [{
    label: 'Items',
    items: [
      { key: 'a', insertText: '@alpha ', data: { label: 'alpha' } },
      { key: 'b', insertText: '@beta ', data: { label: 'beta' } },
    ],
    renderItem: () => null,
  }];
  const triggerState = parseTriggerAt(content, cursorPos, trigger);
  const { result } = renderHook(() => useAutocompletePopup({
    triggerState,
    active: opts.active ?? true,
    getGroups: () => groups,
    content,
    cursorPos,
    applyEdit,
    textareaRef,
  }));
  return { result, applyEdit };
}

describe('parseTriggerAt', () => {
  it('光标前最后一个触发符起解析 query', () => {
    expect(parseTriggerAt('@dev', 4, '@')).toEqual({ start: 0, query: 'dev' });
    expect(parseTriggerAt('hello @de', 9, '@')).toEqual({ start: 6, query: 'de' });
    // 同符多次出现取最后一个
    expect(parseTriggerAt('@a @b', 5, '@')).toEqual({ start: 3, query: 'b' });
  });

  it('无触发符 / query 含空格或换行 → null', () => {
    expect(parseTriggerAt('hello', 5, '@')).toBeNull();
    expect(parseTriggerAt('@ dev', 5, '@')).toBeNull();
    expect(parseTriggerAt('@d\nv', 4, '@')).toBeNull();
  });

  it('cursorPos 截断解析范围（光标后内容不参与）', () => {
    expect(parseTriggerAt('@abc', 2, '@')).toEqual({ start: 0, query: 'a' });
    // cursorPos 越界按内容长度钳位
    expect(parseTriggerAt('@ab', 99, '@')).toEqual({ start: 0, query: 'ab' });
  });
});

describe('useAutocompletePopup — 开合语义（#270 对齐）', () => {
  it('有触发 + 有候选 + active → open', () => {
    const { result } = setup({ content: '@a' });
    expect(result.current.open).toBe(true);
    expect(result.current.items.map(i => i.key)).toEqual(['a', 'b']);
    expect(result.current.activeIdx).toBe(0);
  });

  it('无触发 / 非 active / 无候选 → 不 open 且无候选', () => {
    expect(setup({ content: 'hello' }).result.current.open).toBe(false);
    const suppressed = setup({ content: '@a', active: false });
    expect(suppressed.result.current.open).toBe(false);
    expect(suppressed.result.current.items).toEqual([]);
    const empty = setup({ content: '@a', groups: [{ label: 'Items', items: [], renderItem: () => null }] });
    expect(empty.result.current.open).toBe(false);
  });

  it('Esc 关闭弹框（dismiss 记录触发起点）；resetDismiss 后重开', () => {
    const { result, applyEdit } = setup({ content: '@a' });
    expect(result.current.open).toBe(true);

    let consumed = false;
    act(() => { consumed = result.current.handleKeyDown(keyEvent('Escape')); });
    expect(consumed).toBe(true);
    expect(result.current.open).toBe(false);
    // Esc 不动内容
    expect(applyEdit).not.toHaveBeenCalled();

    act(() => { result.current.resetDismiss(); });
    expect(result.current.open).toBe(true);
  });

  it('弹框未开时 handleKeyDown 不消费事件', () => {
    const { result } = setup({ content: 'hello' });
    const e = keyEvent('ArrowDown');
    let consumed = true;
    act(() => { consumed = result.current.handleKeyDown(e); });
    expect(consumed).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('useAutocompletePopup — 键盘导航', () => {
  it('↓↑ 循环序号（跨组拍平空间取模）', () => {
    const groups: AutocompleteGroup<Item>[] = [
      { label: 'G1', items: [
        { key: 'a', insertText: '@a ', data: { label: 'a' } },
        { key: 'b', insertText: '@b ', data: { label: 'b' } },
      ], renderItem: () => null },
      { label: 'G2', items: [
        { key: 'c', insertText: '@c ', data: { label: 'c' } },
      ], renderItem: () => null },
    ];
    const { result } = setup({ content: '@', groups });

    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    expect(result.current.activeIdx).toBe(1);
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    expect(result.current.activeIdx).toBe(2);
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    expect(result.current.activeIdx).toBe(0); // 到底回卷
    act(() => { result.current.handleKeyDown(keyEvent('ArrowUp')); });
    expect(result.current.activeIdx).toBe(2); // 到顶回卷
  });

  it('Enter 选中当前项：触发位替换文本 + 光标置插入串尾 + onPicked 触发 + 序号归零', () => {
    const onPicked = vi.fn();
    const groups: AutocompleteGroup<Item>[] = [{
      label: 'Items',
      items: [
        { key: 'a', insertText: '@alpha ', data: { label: 'alpha' } },
        { key: 'b', insertText: '@beta ', data: { label: 'beta' }, onPicked },
      ],
      renderItem: () => null,
    }];
    const { result, applyEdit } = setup({ content: 'say @b end', cursorPos: 6, groups });

    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    let consumed = false;
    act(() => { consumed = result.current.handleKeyDown(keyEvent('Enter')); });
    expect(consumed).toBe(true);
    // 触发起点 4 到光标 6 的「@b」被替换为 '@beta '，光标 = 4 + 6
    expect(applyEdit).toHaveBeenCalledWith('say @beta  end', 10);
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(result.current.activeIdx).toBe(0);
  });

  it('Tab 与 Enter 同效选中', () => {
    const { result, applyEdit } = setup({ content: '@a' });
    let consumed = false;
    act(() => { consumed = result.current.handleKeyDown(keyEvent('Tab')); });
    expect(consumed).toBe(true);
    expect(applyEdit).toHaveBeenCalledWith('@alpha ', 7);
  });
});
