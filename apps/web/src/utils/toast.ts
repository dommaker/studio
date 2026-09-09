/**
 * Lightweight toast notification system (zero dependencies)
 * Uses CSS variables from theme.css for dark/light mode support.
 */

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastOptions {
  duration?: number;
  icon?: string;
}

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

const COLORS: Record<ToastType, { bg: string; border: string; text: string }> = {
  success: { bg: 'var(--success-dim)', border: 'var(--success-border)', text: 'var(--success)' },
  error: { bg: 'var(--error-dim)', border: 'var(--error-border)', text: 'var(--error)' },
  warning: { bg: 'var(--warning-dim)', border: 'var(--warning-border)', text: 'var(--warning)' },
  info: { bg: 'var(--info-dim)', border: 'var(--info-border)', text: 'var(--info)' },
};

let container: HTMLDivElement | null = null;

function getContainer(): HTMLDivElement {
  if (container) return container;
  container = document.createElement('div');
  container.id = 'toast-container';
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    pointer-events: none;
    max-width: 400px;
  `;
  document.body.appendChild(container);
  return container;
}

function show(message: string, type: ToastType, options?: ToastOptions): void {
  const duration = options?.duration ?? 4000;
  const icon = options?.icon ?? ICONS[type];
  const colors = COLORS[type];

  const toast = document.createElement('div');
  toast.style.cssText = `
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 4px;
    background: var(--bg-elevated);
    border: 1px solid ${colors.border};
    box-shadow: var(--shadow-md);
    color: var(--text-primary);
    font-size: var(--fs-base);
    font-family: var(--font-sans);
    cursor: pointer;
    max-width: 100%;
    word-break: break-word;
  `;

  const iconEl = document.createElement('span');
  iconEl.style.cssText = `
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: ${colors.bg};
    color: ${colors.text};
    font-size: var(--fs-sm);
    font-weight: 700;
  `;
  iconEl.textContent = icon;

  const msgEl = document.createElement('span');
  msgEl.style.cssText = `flex: 1; line-height: 1.4;`;
  msgEl.textContent = message;

  toast.appendChild(iconEl);
  toast.appendChild(msgEl);

  toast.addEventListener('click', () => removeToast(toast));

  const c = getContainer();
  c.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => removeToast(toast), duration);
  }
}

function removeToast(el: HTMLDivElement): void {
  el.remove();
}

export const toast = Object.assign(
  (message: string, opts?: ToastOptions) => show(message, 'info', opts),
  {
    success: (message: string, opts?: ToastOptions) => show(message, 'success', opts),
    error: (message: string, opts?: ToastOptions) => show(message, 'error', opts),
    warning: (message: string, opts?: ToastOptions) => show(message, 'warning', opts),
    info: (message: string, opts?: ToastOptions) => show(message, 'info', opts),
    dismiss: (el?: HTMLDivElement) => {
      if (el) removeToast(el);
      else container?.querySelectorAll('div').forEach(d => removeToast(d as HTMLDivElement));
    },
  }
);
