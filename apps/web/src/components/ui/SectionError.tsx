export interface SectionErrorProps {
  error: string;
  onRetry: () => void;
  /** 追加外层容器类（如外边距 mb-3/mb-4，由调用侧按布局需要给） */
  className?: string;
}

/** 子拉取失败最小错误行（2026-09 web-ux-optional-fixes Step 1 形态）：u-err-dim 红条 + 重试 */
export function SectionError({ error, onRetry, className }: SectionErrorProps) {
  return (
    <div className={`p-3 rounded u-err-dim u-err text-sm flex items-center justify-between${className ? ` ${className}` : ''}`}>
      <span>{error}</span>
      <button onClick={onRetry} className="btn btn-secondary btn-sm">重试</button>
    </div>
  );
}
