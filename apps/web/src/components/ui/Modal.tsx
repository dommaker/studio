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
 * Respects CSS custom properties (--bg-primary, --border-subtle, etc.).
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
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', zIndex }}
      onClick={onClose}
    >
      <div
        className="w-full rounded-lg overflow-hidden"
        style={{
          maxWidth,
          background: 'var(--bg-primary, #fff)',
          border: '1px solid var(--border-subtle, #e5e7eb)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {title && (
          <div
            className="flex items-center justify-between px-6 py-4"
            style={{ borderBottom: '1px solid var(--border-subtle, #e5e7eb)' }}
          >
            <h2
              className="text-lg font-semibold"
              style={{ color: 'var(--text-primary, #111)' }}
            >
              {title}
            </h2>
            {onClose && (
              <button
                onClick={onClose}
                className="text-xl cursor-pointer"
                style={{
                  color: 'var(--text-secondary, #6b7280)',
                  background: 'none',
                  border: 'none',
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-4 max-h-[70vh] overflow-auto">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div
            className="flex justify-end gap-3 px-6 py-4"
            style={{ borderTop: '1px solid var(--border-subtle, #e5e7eb)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
