// WU 生命周期纯函数（#396，spec §5.1/§5.3）：四站 stepper 模型 + 关键事件派生。
// 四站 = 待领取 → 进行中 → 待验收 → 完成/关闭；blocked/挂起/证据层是事件不是站点（chip 行展示，不做第二条竖向时间线）。
// 铁律沿用：站序由 deriveDisplayState 的 column 驱动，不自行解释 attestations（证据只作事件/时间戳展示）。
import type { DerivedWuState, WuAttestations, WuDisplayColumn } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../api/workunit';

export type WuStationId = 'claim' | 'progress' | 'review' | 'done';
export type WuStationState = 'done' | 'current' | 'upcoming';

export interface WuStation {
  id: WuStationId;
  label: string;
  time: string | null;
  state: WuStationState;
}

export interface WuKeyEvent {
  id: string;
  label: string;
  detail?: string;
  time: string | null;
  tone: 'accent' | 'warn' | 'danger';
}

export const WU_STATION_ORDER: WuStationId[] = ['claim', 'progress', 'review', 'done'];

export function stationIndex(column: WuDisplayColumn): number {
  switch (column) {
    case 'pending':
    case 'unassigned':
      return 0;
    case 'active':
    case 'blocked':
      return 1;
    case 'in_review':
      return 2;
    case 'done':
    case 'closed':
      return 3;
  }
}

/**
 * 四站 + 关键事件派生。
 * 「待验收」站时间戳口径（§5.6.2，本函数即定口径处）：无专用字段，取 `attestations.l2.at ?? l1.at` 近似
 * （证据产生 ≈ 进入验收）；无证据 → null（UI 显示 `-`）。
 */
export function buildLifecycle(
  wu: WorkUnit,
  derived: DerivedWuState,
  meta: Record<string, unknown>,
  attestations: WuAttestations | undefined,
): { stations: WuStation[]; events: WuKeyEvent[] } {
  const cur = stationIndex(derived.column);
  const finished = derived.column === 'done' || derived.column === 'closed';
  const times: Record<WuStationId, string | null> = {
    claim: wu.createdAt,
    progress: wu.claimedAt,
    review: attestations?.l2?.at ?? attestations?.l1?.at ?? null,
    done: wu.completedAt,
  };
  const labels: Record<WuStationId, string> = {
    claim: '待领取',
    progress: '进行中',
    review: '待验收',
    done: derived.column === 'closed' ? '关闭' : '完成',
  };
  const stations: WuStation[] = WU_STATION_ORDER.map((id, i) => ({
    id,
    label: labels[id],
    time: times[id],
    state: i < cur ? 'done' : i === cur ? (finished ? 'done' : 'current') : 'upcoming',
  }));

  const events: WuKeyEvent[] = [];
  if (wu.status === 'pending') {
    events.push({ id: 'gate-pending', label: '待确认人闸（确认后进待领取）', time: wu.createdAt, tone: 'warn' });
  }
  if (derived.column === 'blocked') {
    events.push({ id: 'blocked', label: '阻塞', detail: wu.failureType ?? undefined, time: wu.updatedAt, tone: 'danger' });
  } else if (wu.failureType) {
    events.push({ id: 'failure', label: '失败', detail: wu.failureType, time: wu.updatedAt, tone: 'danger' });
  }
  if (meta.waitingForInput) {
    events.push({
      id: 'waiting',
      label: '挂起等待输入',
      detail: typeof meta.waitingQuestion === 'string' ? meta.waitingQuestion : undefined,
      time: typeof meta.waitingSince === 'string' ? meta.waitingSince : wu.updatedAt,
      tone: 'warn',
    });
  }
  // 证据层事件（时间戳真实存在，是最可靠的事件源）
  // 标签白话对齐 #385 词表（正本 pmo/pipelineUtils.EVIDENCE_LAYER_LABELS），L1/L2/L3 编号不上界面
  const levels: Array<['l1' | 'l2' | 'l3', string]> = [
    ['l1', '自动验证'],
    ['l2', 'Agent 评审'],
    ['l3', '人工确认'],
  ];
  for (const [key, name] of levels) {
    const e = attestations?.[key];
    if (!e) continue;
    events.push({
      id: key,
      label: `${name}${e.verdict === 'approved' ? '通过' : '否决'}${e.selfReview ? '（自评）' : ''}`,
      detail: e.summary,
      time: e.at,
      tone: e.verdict === 'approved' ? 'accent' : 'danger',
    });
  }
  return { stations, events };
}
