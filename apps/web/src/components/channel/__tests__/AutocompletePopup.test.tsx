// AutocompletePopup（#691，自 ChannelInput @/# 弹框 JSX 抽出的统一展示件）：
// listbox/option ARIA、组头仅在有候选时渲染、跨组统一序号高亮、onMouseDown 选中
// （preventDefault 保输入框焦点）、附加类名合并。
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { AutocompletePopup } from '../AutocompletePopup';
import type { AutocompleteGroup, AutocompleteItem } from '../../../hooks/useAutocompletePopup';

interface Item {
  label: string;
}

const item = (key: string): AutocompleteItem<Item> => ({ key, insertText: `${key} `, data: { label: key } });

function setup(opts?: { activeIdx?: number; className?: string; groups?: AutocompleteGroup<Item>[] }) {
  const onPick = vi.fn();
  const activeItemRef = createRef<HTMLButtonElement>();
  const groups = opts?.groups ?? [
    { label: 'Agents', items: [item('a1'), item('a2')], renderItem: (i: AutocompleteItem<Item>) => <span>@{i.data.label}</span> },
    { label: 'Files', items: [item('f1')], renderItem: (i: AutocompleteItem<Item>) => <span>{i.data.label}</span> },
  ];
  const { container } = render(
    <AutocompletePopup
      ariaLabel="候选"
      className={opts?.className}
      groups={groups}
      activeIdx={opts?.activeIdx ?? 0}
      activeItemRef={activeItemRef}
      onPick={onPick}
    />,
  );
  return { container, onPick, activeItemRef };
}

describe('AutocompletePopup', () => {
  it('listbox/option ARIA + 附加类名合并', () => {
    const { container } = setup({ className: 'mc-pmo-popup' });
    const listbox = container.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-label')).toBe('候选');
    expect(listbox.className).toBe('mc-mention-popup mc-pmo-popup');
    expect(container.querySelectorAll('[role="option"]').length).toBe(3);
  });

  it('组头仅在该组有候选时渲染', () => {
    const { container } = setup({
      groups: [
        { label: 'Agents', items: [], renderItem: () => null },
        { label: 'Files', items: [item('f1')], renderItem: () => null },
      ],
    });
    const headers = Array.from(container.querySelectorAll('.mc-mention-group')).map(el => el.textContent);
    expect(headers).toEqual(['Files']);
  });

  it('activeIdx 为跨组统一序号：命中项 aria-selected + active 类 + 挂 activeItemRef', () => {
    const { container, activeItemRef } = setup({ activeIdx: 2 });
    const options = container.querySelectorAll('[role="option"]');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[2].getAttribute('aria-selected')).toBe('true');
    expect(options[2].className).toBe('mc-mention-item mc-mention-item-active');
    expect(activeItemRef.current).toBe(options[2]);
  });

  it('onMouseDown 选中：preventDefault 保焦点 + onPick 上送该候选', () => {
    const { container, onPick } = setup();
    const option = container.querySelectorAll('[role="option"]')[1];
    const e = fireEvent.mouseDown(option);
    expect(e).toBe(false); // preventDefault 生效
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].key).toBe('a2');
  });
});
