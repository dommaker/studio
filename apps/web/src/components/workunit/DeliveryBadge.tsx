import { WU_DELIVERY_COLORS, WU_DELIVERY_LABELS, type WuDeliveryState } from '@dommaker/studio-shared/web';

/** 代码 WU 交付子状态徽标；与 WU 主状态并列，不改变主状态。 */
export function DeliveryBadge({ delivery }: { delivery: WuDeliveryState | null }) {
  if (!delivery) return null;
  return (
    <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${WU_DELIVERY_COLORS[delivery] ?? 'u-surface-2 u-text-3'}`}>
      {WU_DELIVERY_LABELS[delivery] ?? delivery}
    </span>
  );
}
