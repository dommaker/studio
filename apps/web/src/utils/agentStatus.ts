// Agent 卡片状态推导与时间格式化（2026-07-31 全流程串联 UX 重构 §5.2/§5.3）
// 纯函数抽出以便单测；配色沿用原 AgentDashboardPage pill 语义（绿=执行、灰=空闲/未启动、黄=异常/待评审、红=阻塞/终止）

/** 卡片状态键：active 实例按当前 WU.status 细分 */
export type AgentStatusKey =
  | 'running'    // 执行中（active + WU active/其他）
  | 'in_review'  // 待评审（active + WU in_review）
  | 'blocked'    // 阻塞（active + WU blocked）
  | 'idle'       // 空闲
  | 'error'      // 异常
  | 'terminated' // 已终止
  | 'none';      // 未启动（无 instance）

export const AGENT_STATUS_LABELS: Record<AgentStatusKey, string> = {
  running: '执行中',
  in_review: '待评审',
  blocked: '阻塞',
  idle: '空闲',
  error: '异常',
  terminated: '已终止',
  none: '未启动',
};

export const AGENT_STATUS_COLORS: Record<AgentStatusKey, string> = {
  running: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  blocked: 'u-err-dim u-err',
  idle: 'u-surface-2 u-text-3',
  error: 'u-warn-dim u-warn',
  terminated: 'u-err-dim u-err',
  none: 'u-surface-2 u-text-3',
};

/**
 * 状态推导：instance.status + 当前 WU.status → 卡片状态键。
 * 无 instance（null/undefined）→ 'none'；未知 instance.status 原样兜底为 'idle' 以外的键不存在，归入 'none'。
 */
export function deriveAgentStatus(
  instanceStatus: string | null | undefined,
  currentWorkUnitStatus?: string | null,
): AgentStatusKey {
  if (!instanceStatus) return 'none';
  if (instanceStatus === 'active') {
    if (currentWorkUnitStatus === 'in_review') return 'in_review';
    if (currentWorkUnitStatus === 'blocked') return 'blocked';
    return 'running';
  }
  if (instanceStatus === 'idle') return 'idle';
  if (instanceStatus === 'error') return 'error';
  if (instanceStatus === 'terminated') return 'terminated';
  return 'none';
}

/** 运行时长 / 已耗时：从 startedAt（或 claimedAt）起算，"5m" / "2h 30m" / "1d 4h" */
export function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** 相对时间（"最近一条动态 · 30s前"）：<60s → Ns前；<60m → Nm前；<24h → Nh前；否则 Nd前 */
export function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const secs = Math.max(Math.floor(ms / 1000), 0);
  if (secs < 60) return `${secs}s前`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h前`;
  return `${Math.floor(hours / 24)}d前`;
}
