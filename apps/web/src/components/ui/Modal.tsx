import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { IconX } from './icons';

interface ModalProps {
  open?: boolean;
  onClose?: () => void;
  children: ReactNode;
  /** CSS max-width value, default: '600px' */
  maxWidth?: string;
  /** Optional title rendered in a header bar */
  title?: ReactNode;
  /** Optional footer rendered at the bottom */
  footer?: ReactNode;
  /** z-index override（缺省不出 inline style，走 theme.css .modal-overlay 的 --z-overlay(50)——
   *  显式传值会压过 .mc-workbar .modal-overlay{z-index:--z-modal-above(400)} 等作用域覆盖，慎用） */
  zIndex?: number;
  /** modal-body 的内联覆盖（仅组件特有参数，如 AuthModal 整体 padding；样式能走类的走类） */
  bodyStyle?: CSSProperties;
}

/** 弹窗内首个可聚焦元素的选择器（打开时焦点落点；无命中则聚焦弹窗本体） */
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Reusable modal overlay + content shell.
 * 结构走 theme.css 的 modal-* 组件类（style-guide §4.3），颜色全部经 CSS 变量解析。
 * 批次 F-2 a11y 基座：Escape 关闭 + role="dialog"/aria-modal + 焦点管理
 * （打开时焦点进弹窗首个可聚焦元素，无则弹窗本体；关闭/卸载时还焦触发前的 document.activeElement）。
 */
export function Modal({
  open = true,
  onClose,
  children,
  maxWidth = '600px',
  title,
  footer,
  zIndex,
  bodyStyle,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Escape 关闭（监听随关闭/卸载清理；无 onClose 不挂监听）
  useEffect(() => {
    if (!open || !onClose) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Select 选项面板（portal 到 body，仅打开时在 DOM）在岗时让其自管 Escape，避免一按双关
      if (document.querySelector('.select-panel')) return;
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // 焦点进出：仅在 open 翻转时执行，不受 onClose 等回调身份变化影响（避免弹窗内输入被抢焦）
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement;
    const content = contentRef.current;
    const first = content?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? content)?.focus();
    return () => {
      if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" style={zIndex !== undefined ? { zIndex } : undefined} onClick={onClose}>
      <div
        ref={contentRef}
        className="modal"
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {title && (
          <div className="modal-header">
            <h2 className="modal-title">{title}</h2>
            {onClose && (
              <button onClick={onClose} className="modal-close" aria-label="关闭">
                <IconX />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="modal-body" style={{ paddingTop: title ? undefined : 16, ...bodyStyle }}>
          {children}
        </div>

        {/* Footer */}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
