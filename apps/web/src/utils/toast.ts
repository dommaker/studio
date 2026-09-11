/**
 * Lightweight toast notification system (zero dependencies)
 * Uses CSS variables from theme.css for dark/light mode support.
 *
 * 批次 E-3（已批治理项，Governance-Approved: session）：toast 进出场 fade——
 * 进场 opacity 0→1、出场 1→0 过渡结束后移除（--motion-base），归入白名单场景②
 * 「弹窗进出场」语义扩展；prefers-reduced-motion 下 transition 被全局媒体查询
 * 压到 0.01ms，天然兼容（仅多停一个淡出时长再移除，无动画残留）。
 */

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastOptions {
  duration?: number;
  icon?: string;
  /** D-2（行动中心「下一个待办」）：可选行动按钮——点击执行 onClick 并关闭本 toast */
  action?: { label: string; onClick: () => void };
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

/** 读 --motion-base token（如 "150ms"）得毫秒数，供出场过渡结束后的移除定时；读不到回退 150 */
function motionBaseMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim();
  const ms = /^([\d.]+)ms$/.exec(raw);
  if (ms) return Number(ms[1]);
  const s = /^([\d.]+)s$/.exec(raw);
  if (s) return Number(s[1]) * 1000;
  return 150;
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
    opacity: 0;
    transition: opacity var(--motion-base) var(--ease-standard);
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

  // D-2：可选行动按钮（btn 体系；stopPropagation 防触发整 toast 的点击关闭，动作后主动关）
  if (options?.action) {
    const { label, onClick } = options.action;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.style.flexShrink = '0';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      removeToast(toast);
    });
    toast.appendChild(btn);
  }

  toast.addEventListener('click', () => removeToast(toast));

  const c = getContainer();
  c.appendChild(toast);

  // 进场 fade：以 opacity:0 挂载，下一帧置 1 触发过渡
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  if (duration > 0) {
    setTimeout(() => removeToast(toast), duration);
  }
}

function removeToast(el: HTMLDivElement): void {
  // 幂等：duration 定时器 / 点击关闭 / dismiss 可能并发触发同一元素
  if (el.dataset.closing) return;
  el.dataset.closing = '1';
  // 出场 fade：opacity → 0，过渡结束后移除
  el.style.opacity = '0';
  setTimeout(() => el.remove(), motionBaseMs());
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
