// Skeleton — 批次 E-2 静态骨架占位（docs/plans/2026-09-ui-polish-batch-e.md AC1）
// 硬约束：零动画（shimmer/pulse 皆违反 style-guide §2.5 动效白名单），纯静态色块。
// 样式类 .skeleton 系在 theme.css「加载状态」区（紧邻 .loading-spinner）；
// 整块 aria-hidden 不进读屏（加载语义由外层分支承担，色块本身无信息）。

export interface SkeletonTextProps {
  /** 行数（默认 3） */
  lines?: number;
  /** 逐行宽度（px 数或 CSS 宽度如 '60%'）；缺省全部 100% */
  widths?: Array<number | string>;
  /** 容器类（行间距等布局由调用方给，如 'space-y-3'） */
  className?: string;
}

const toCssWidth = (w: number | string) => (typeof w === 'number' ? `${w}px` : w);

/** 文本行骨架：lines 行 12px 高色块 */
export function SkeletonText({ lines = 3, widths, className }: SkeletonTextProps) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton skeleton-text"
          style={widths?.[i] != null ? { width: toCssWidth(widths[i]) } : undefined}
        />
      ))}
    </div>
  );
}

export interface SkeletonCardProps {
  /** 块高度 px（默认 96） */
  height?: number;
  className?: string;
}

/** 卡片块骨架：整块色块，高度可配 */
export function SkeletonCard({ height = 96, className }: SkeletonCardProps) {
  return (
    <div
      className={['skeleton', className].filter(Boolean).join(' ')}
      style={{ height }}
      aria-hidden="true"
    />
  );
}
