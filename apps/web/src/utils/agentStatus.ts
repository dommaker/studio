// Agent 卡片状态推导与时间格式化（2026-07-31 全流程串联 UX 重构 §5.2/§5.3）
// 纯函数抽出以便单测；内部细分态（7+1）保留作细分依据，UI 展示层合并为 4 态
// （工作中 / 待处理 / 空闲 / 离线，见 DisplayStatusKey）；展示色：绿=工作中 / 黄=待处理 / 灰=空闲·离线

/** 卡片状态键：active 实例按当前 WU.status 细分 */
export type AgentStatusKey =
  | 'running'    // 执行中（active + WU active/其他）
  | 'in_review'  // 待评审（active + WU in_review）
  | 'blocked'    // 阻塞（active + WU blocked）
  | 'idle'       // 空闲
  | 'error'      // 异常
  | 'terminated' // 已终止
  | 'none';      // 未启动（无 instance）

/** 卡面状态键 = AgentStatusKey + disabled（profile 被停用，覆盖 instance 维度） */
export type CardStatusKey = AgentStatusKey | 'disabled';

export const AGENT_STATUS_LABELS: Record<AgentStatusKey, string> = {
  running: '执行中',
  in_review: '待评审',
  blocked: '阻塞',
  idle: '空闲',
  error: '异常',
  terminated: '已终止',
  none: '未启动',
};

export const CARD_STATUS_LABELS: Record<CardStatusKey, string> = {
  ...AGENT_STATUS_LABELS,
  disabled: '已停用',
};

export const AGENT_STATUS_COLORS: Record<AgentStatusKey, string> = {
  running: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  blocked: 'u-err-dim u-err',
  idle: 'u-surface-2 u-text-3',
  error: 'u-anomaly-dim u-anomaly', // §6.5：异常=橙，与待评审黄解耦
  terminated: 'u-surface-2 u-text-3', // §6.5：红只编码阻塞，终止归灰
  none: 'u-surface-2 u-text-3',
};

/** 卡面色 = AgentStatusKey 色 + disabled 归灰（#433：详情页 pill 与仪表盘卡面 pill 同词同色同源消费） */
export const CARD_STATUS_COLORS: Record<CardStatusKey, string> = {
  ...AGENT_STATUS_COLORS,
  disabled: 'u-surface-2 u-text-3',
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

/** 卡面状态统一口径（#397 §6.3：卡片 pill / 页头筛选 chip / 排序三处同源）：profile 停用优先于 instance 维度 */
export function resolveCardStatusKey(
  profileStatus: string | null | undefined,
  instanceStatus: string | null | undefined,
  currentWorkUnitStatus?: string | null,
): CardStatusKey {
  if (profileStatus !== 'active') return 'disabled';
  return deriveAgentStatus(instanceStatus, currentWorkUnitStatus);
}

/** 展示状态键（UI 4 态口径）：内部 7+1 细分态不删，作细分依据（详情页小字 / error 红点角标） */
export type DisplayStatusKey =
  | 'working'   // 工作中（running）
  | 'attention' // 待处理（in_review / blocked / error）
  | 'idle'      // 空闲（idle）
  | 'offline';  // 离线（none / terminated / disabled）

export const DISPLAY_STATUS_LABELS: Record<DisplayStatusKey, string> = {
  working: '工作中',
  attention: '待处理',
  idle: '空闲',
  offline: '离线',
};

/** 展示状态色（与细分态 §6.5 单义同系）：绿=工作中（u-accent）/ 黄=待处理（u-warn）/ 灰=空闲·离线 */
export const DISPLAY_STATUS_COLORS: Record<DisplayStatusKey, string> = {
  working: 'u-accent-dim u-accent',
  attention: 'u-warn-dim u-warn',
  idle: 'u-surface-2 u-text-3',
  offline: 'u-surface-2 u-text-3',
};

/** 细分态 → 展示态唯一映射表（pill / 页头筛选 chip / 统计 / 排序同源消费） */
export const CARD_TO_DISPLAY_STATUS: Record<CardStatusKey, DisplayStatusKey> = {
  running: 'working',
  in_review: 'attention',
  blocked: 'attention',
  error: 'attention',
  idle: 'idle',
  none: 'offline',
  terminated: 'offline',
  disabled: 'offline',
};

/** 展示状态统一口径：内部走 resolveCardStatusKey 细分再映射 */
export function resolveDisplayStatus(
  profileStatus: string | null | undefined,
  instanceStatus: string | null | undefined,
  currentWorkUnitStatus?: string | null,
): DisplayStatusKey {
  return CARD_TO_DISPLAY_STATUS[resolveCardStatusKey(profileStatus, instanceStatus, currentWorkUnitStatus)];
}

/** 注意力排序（4 态口径）：待处理 → 工作中 → 空闲 → 离线 */
export const AGENT_STATUS_RANK: Record<DisplayStatusKey, number> = {
  attention: 0,
  working: 1,
  idle: 2,
  offline: 3,
};

/** 页头筛选维度（4 态口径）；'all' 不过滤 */
export type StatusFilter = 'all' | DisplayStatusKey;

export function matchesStatusFilter(key: CardStatusKey, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return CARD_TO_DISPLAY_STATUS[key] === filter;
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
