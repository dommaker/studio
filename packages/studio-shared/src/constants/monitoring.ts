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
