// Button — 带 loading 态的通用按钮，包装 theme.css 的 .btn / .btn-{variant} / .btn-sm 类体系
// loading 时禁用点击并置 aria-busy，前置 .btn-spinner 内联小转圈（currentColor 着色，深浅主题自适应）；
// 可用 loadingLabel 替换 loading 期间的文案（如「运行中…」，与 ManualTaskButton 同款口径）。
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体，对应 theme.css .btn-{variant}（默认 primary） */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning';
  /** 尺寸：sm 追加 .btn-sm（默认 md） */
  size?: 'sm' | 'md';
  /** 加载中：禁用 + spinner；loadingLabel 可替换此期间文案 */
  loading?: boolean;
  loadingLabel?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingLabel,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {loading && loadingLabel != null ? loadingLabel : children}
    </button>
  );
}
