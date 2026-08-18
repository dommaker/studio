/**
 * 监控探针阈值（#181 决策 #62 D2/D3 + #167③）--api 探针与 Web 下钻口径同源（#209 smell 3）。
 * 放 shared：apps/api 探针告警分级与 apps/web「需要处理」卡住计数必须同一数值，手写复刻会漂移。
 */

// 池滞留（unassigned 最老 createdAt）：>2h warning / >12h critical
export const POOL_STAGNATION_WARN_MS = 2 * 60 * 60 * 1000;
export const POOL_STAGNATION_CRIT_MS = 12 * 60 * 60 * 1000;

// in_review 滞留（人工确认队列以天计，不对齐池滞留）：>24h warning / >72h critical
export const REVIEW_STAGNATION_WARN_MS = 24 * 60 * 60 * 1000;
export const REVIEW_STAGNATION_CRIT_MS = 72 * 60 * 60 * 1000;

// 告警指纹冷却去重（#220，#218 决议）：同指纹 warning 4h / critical 1h 内只出声一次；惰性 GC 24h
export const ALERT_COOLDOWN_WARN_MS = 4 * 60 * 60 * 1000;
export const ALERT_COOLDOWN_CRIT_MS = 60 * 60 * 1000;
export const ALERT_COOLDOWN_GC_MS = 24 * 60 * 60 * 1000;

// 认领陈旧守卫（#221，#214 决议）：unassigned WU updatedAt 超 72h 在 observe 可见性层拦截
// （不可见、不认领、状态不动），首次拦截由 monitor 探针 stale_claim_guard 告警。
// 三道防线的语义分层：租约超时释放（分钟级，#63）管执行中 → 池滞留探针 2h warn/12h crit
// （上方 POOL_STAGNATION_*，#62）管新鲜滞留 → 本守卫 72h 管僵尸复活拦截。
export const STALE_CLAIM_GUARD_MS = 72 * 60 * 60 * 1000;

/**
 * 陈旧沉睡判定（#221）：observe 过滤与 stale_claim_guard 探针同源（同一道防线同一口径）。
 * updatedAt 非有限值（损坏数据）按「不陈旧」放行——维持既有可见性，不静默滞留。
 */
export function isStaleClaimSleep(updatedAtIso: string, nowMs: number): boolean {
  const t = new Date(updatedAtIso).getTime();
  return Number.isFinite(t) && nowMs - t > STALE_CLAIM_GUARD_MS;
}

/** 相对时间：iso -> 「N 分钟/小时/天前」（#209 smell 3：MonitoringPage 与 NeedsAttentionSection 同源） */
export function formatAge(iso?: string): string {
  if (!iso) return '时间未知';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
