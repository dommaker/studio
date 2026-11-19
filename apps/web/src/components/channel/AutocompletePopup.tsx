// AutocompletePopup（#691，docs/plans/2026-10-arch-simplification.md Phase 2-2）：
// @/# 补全弹框统一展示件（自 ChannelInput 两处同构 JSX 抽出）——listbox/option ARIA、
// 组头（label 非空且组内有候选才渲染）、跨组统一序号高亮、onMouseDown 选中
// （preventDefault 保输入框焦点）。状态机（开合/键盘/插入）在 hooks/useAutocompletePopup。
import { Fragment } from 'react';
import type { RefObject } from 'react';
import type { AutocompleteGroup, AutocompleteItem } from '../../hooks/useAutocompletePopup';

interface Props<T> {
  ariaLabel: string;
  /** 附加类名（如 PMO 弹框的 mc-pmo-popup 样式区分钩） */
  className?: string;
  groups: AutocompleteGroup<T>[];
  /** 跨组统一选中序号（与 useAutocompletePopup.activeIdx 同空间） */
  activeIdx: number;
  activeItemRef: RefObject<HTMLButtonElement | null>;
  onPick: (item: AutocompleteItem<T>) => void;
}

export function AutocompletePopup<T>({ ariaLabel, className, groups, activeIdx, activeItemRef, onPick }: Props<T>) {
  let flatIdx = 0;
  return (
    <div
      className={className ? `mc-mention-popup ${className}` : 'mc-mention-popup'}
      role="listbox"
      aria-label={ariaLabel}
    >
      {groups.map((group, gi) => (
        <Fragment key={group.label ?? gi}>
          {group.label && group.items.length > 0 && <div className="mc-mention-group">{group.label}</div>}
          {group.items.map(item => {
            const i = flatIdx++;
            return (
              <button
                key={item.key}
                ref={i === activeIdx ? activeItemRef : null}
                role="option"
                aria-selected={i === activeIdx}
                className={i === activeIdx ? 'mc-mention-item mc-mention-item-active' : 'mc-mention-item'}
                onMouseDown={e => { e.preventDefault(); onPick(item); }}
              >
                {group.renderItem(item)}
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
