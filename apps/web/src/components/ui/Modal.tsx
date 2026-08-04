import type { ReactNode } from 'react';

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
  /** z-index override (default 50) */
  zIndex?: number;
}

/**
 * Reusable modal overlay + content shell.
 * 结构走 theme.css 的 modal-* 组件类（style-guide §4.3），颜色全部经 CSS 变量解析。
 */
export function Modal({
  open = true,
  onClose,
  children,
  maxWidth = '600px',
  title,
  footer,
  zIndex = 50,
}: ModalProps) {
  if (!open) return null;

  return (
    <div className="modal-overlay" style={{ zIndex }} onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {title && (
          <div className="modal-header">
            <h2 className="modal-title">{title}</h2>
            {onClose && (
              <button onClick={onClose} className="modal-close" aria-label="关闭">
                ✕
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="modal-body" style={{ paddingTop: title ? undefined : 16 }}>
          {children}
        </div>

        {/* Footer */}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
