/**
 * #464：「已沉睡」徽标 —— 72h 认领陈旧守卫命中的 WU。
 * 判定与后端同源：metadata.staleGuardBlockedAt === updatedAt（守卫首次拦截时落盘的
 * 沉睡锚点，见 monitor-probes.checkStaleClaimGuard）且仍处于 unassigned——
 * 任何写刷新 updatedAt 即复活，徽标随之消失（零额外同步机制）。
 * 此前此类 WU 在列表/详情仍显示「待领取」，用户等不到认领也不知道为什么。
 */
export function StaleSleepBadge({ wu }: { wu: { status: string; updatedAt: string; metadata?: string | null } }) {
  let staleGuardBlockedAt: string | undefined;
  try {
    staleGuardBlockedAt = wu.metadata ? JSON.parse(wu.metadata).staleGuardBlockedAt : undefined;
  } catch {
    staleGuardBlockedAt = undefined;
  }
  const isSleeping = wu.status === 'unassigned' && !!staleGuardBlockedAt && staleGuardBlockedAt === wu.updatedAt;
  if (!isSleeping) return null;
  return (
    <span
      className="wu-chip wu-chip-warn shrink-0 whitespace-nowrap"
      title="超过 72h 未被动过，已被认领守卫拦截，不会被自动认领——回复本工单即复活；确认无需执行请回复「关闭」"
    >
      已沉睡
    </span>
  );
}
