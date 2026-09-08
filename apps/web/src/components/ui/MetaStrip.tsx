// MetaStrip — #440 Phase 3：详情页标题下密排元信息条。
// 语义对齐 PMO 页既有 meta 行（ProjectDetailPage PMO-a）：有值才显示、无值项省略、全空不占位。
import type { ReactNode } from 'react';

export interface MetaItem {
  key: string;
  label: string;
  /** null / undefined / '' = 该项不渲染 */
  value: ReactNode;
}

interface Props {
  items: MetaItem[];
  /** 缺省 = PMO 页既有 meta 行同款密排类（text-sm u-text-2 flex flex-wrap gap-x-4） */
  className?: string;
}

export function MetaStrip({ items, className }: Props) {
  const visible = items.filter(it => it.value !== null && it.value !== undefined && it.value !== '');
  if (visible.length === 0) return null;
  return (
    <div className={className ?? 'text-sm u-text-2 mt-1 flex flex-wrap gap-x-4 gap-y-1'}>
      {visible.map(it => (
        <span key={it.key}>{it.label}: {it.value}</span>
      ))}
    </div>
  );
}
