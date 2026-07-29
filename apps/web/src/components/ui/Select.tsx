// Select — 主题感知下拉选择，原生 <select> 的 drop-in 替代
// 原生 select 的弹出面板由 OS 绘制、无法适配深色主题；本组件触发器视觉对齐 .input，
// 选项面板 portal 到 document.body（fixed 定位，不被 modal-body 等 overflow 容器裁剪）。
// 样式类 .select-* 见 theme.css，颜色全部消费变量（docs/specs/ui/style-guide.md §4）。
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** value 为空时触发器显示的占位文本（--text-tertiary） */
  placeholder?: string;
  disabled?: boolean;
  /** 叠加到触发器 */
  className?: string;
  style?: CSSProperties;
  id?: string;
  title?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

interface PanelPos {
  top: number;
  left: number;
  width: number;
}

export function Select(props: SelectProps) {
  const { value, onChange, options, placeholder, disabled, className, style, id, title } = props;
  const ariaLabel = props['aria-label'];
  const testId = props['data-testid'];

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const close = () => setOpen(false);

  const openPanel = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    const selectedIdx = options.findIndex((o) => o.value === value && !o.disabled);
    setHighlight(selectedIdx >= 0 ? selectedIdx : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  const selectOption = (opt: SelectOption) => {
    onChange(opt.value);
    close();
    triggerRef.current?.focus();
  };

  // 打开期间：点外部 / Escape / resize / 滚动（面板自身滚动除外）关闭
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // 键盘高亮项滚入可视区（jsdom 无 scrollIntoView 实现，防御性调用）
  useEffect(() => {
    if (!open || highlight < 0) return;
    const el = panelRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight, open]);

  const moveHighlight = (dir: 1 | -1) => {
    if (options.length === 0) return;
    let i = highlight;
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setHighlight(i);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveHighlight(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveHighlight(-1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const opt = options[highlight];
        if (opt && !opt.disabled) selectOption(opt);
        break;
      }
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close();
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={['select-trigger', className].filter(Boolean).join(' ')}
        style={style}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={value === '' ? 'select-value select-placeholder' : 'select-value'}>
          {selected ? selected.label : value === '' ? placeholder ?? '' : value}
        </span>
        <span className="select-arrow" aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="select-panel"
          role="listbox"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {options.map((o, i) => (
            <div
              key={`${i}-${o.value}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={[
                'select-option',
                o.value === value ? 'is-selected' : '',
                o.disabled ? 'is-disabled' : '',
                i === highlight ? 'is-highlighted' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => { if (!o.disabled) selectOption(o); }}
            >
              <span className="select-option-label">{o.label}</span>
              {o.value === value && <span className="select-check" aria-hidden="true">✓</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
