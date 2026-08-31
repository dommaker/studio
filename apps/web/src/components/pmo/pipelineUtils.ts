// PMO 进度管道 — 纯函数（泳道分组 / 完成度 / 耗时 / 项目动态拼装）
// 组件见 ProjectPipeline.tsx / ProjectActivity.tsx；数据流见 ProjectDetailPage
import { deriveDisplayState } from '@dommaker/studio-shared/web';

/** 进度管道六泳道（pending = #126 待确认人闸：扩范围单创建落点，人工确认才进待领取） */
export type PipelineLane = 'pending' | 'unassigned' | 'active' | 'in_review' | 'blocked' | 'done';

/** 交付证据三层白话词表（#399 §8.3：L1/L2/L3 不上界面；缺层文案 = `缺${label}`）。PMO 域唯一出口 */
export const EVIDENCE_LAYER_LABELS = {
  l1: '自动验证',
  l2: 'Agent 评审',
  l3: '人工确认',
} as const;
export type EvidenceLayer = keyof typeof EVIDENCE_LAYER_LABELS;

/** 管道 WU：REQ chain 条目（§10 起 chain 自带 type/时间戳，不再 N+1 详情补全） */
export interface PipelineWorkUnit {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  metadata?: string | null;
  /** 类型 chip */
  type?: string;
  createdAt?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
}

/**
 * WU → 泳道。F6 铁律：分列只准看 deriveDisplayState 派生列（done 缺 L3 回「待验收」列等人工确认）。
 * failed/completed 不在门模型状态词表内（防御性归并）：终结态直接进「完成」列。
 */
export function laneOfWorkUnit(wu: Pick<PipelineWorkUnit, 'status' | 'metadata'>): PipelineLane {
  if (wu.status === 'failed' || wu.status === 'completed') return 'done';
  const column = deriveDisplayState({ status: wu.status, metadata: wu.metadata }).column;
  return column === 'done' || column === 'closed' ? 'done' : column;
}

/** 泳道分组（保持输入顺序，chain 已按 createdAt 升序） */
export function groupWorkUnitsByLane(wus: PipelineWorkUnit[]): Record<PipelineLane, PipelineWorkUnit[]> {
  const lanes: Record<PipelineLane, PipelineWorkUnit[]> = {
    pending: [],
    unassigned: [],
    active: [],
    in_review: [],
    blocked: [],
    done: [],
  };
  for (const wu of wus) lanes[laneOfWorkUnit(wu)].push(wu);
  return lanes;
}

/** 总进度：完成口径 = workFinished 所有权口径（铁律：进度统计不用 column） */
export function computePipelineProgress(wus: PipelineWorkUnit[]): { finished: number; total: number; percent: number } {
  const finished = wus.filter(wu => {
    if (wu.status === 'failed' || wu.status === 'completed') return true;
    return deriveDisplayState({ status: wu.status, metadata: wu.metadata }).workFinished;
  }).length;
  const total = wus.length;
  return { finished, total, percent: total > 0 ? Math.round((finished / total) * 100) : 0 };
}

/** 耗时格式化：claimedAt → completedAt（无 completedAt = 至今）。<1h→"45m"，<1d→"3h20m"，否则"2d3h" */
export function formatDuration(startIso?: string | null, endIso?: string | null, now: number = Date.now()): string | null {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const parsedEnd = endIso ? Date.parse(endIso) : NaN;
  const end = Number.isNaN(parsedEnd) ? now : parsedEnd;
  const mins = Math.max(0, Math.floor((end - start) / 60000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

/** 项目动态条目（kind: created/claimed/completed 来自 WU 时间戳；delivered 来自项目交付记录） */
export interface ProjectTimelineEntry {
  id: string;
  at: string;                 // ISO 时间
  kind: 'created' | 'claimed' | 'completed' | 'delivered';
  wuId?: string;
  title?: string;
  /** claimed 条目的认领人名（名册解析失败 → null，渲染回退 'agent'） */
  actorName?: string | null;
  /** completed 条目的 WU 状态（渲染「完成（状态）」） */
  status?: string;
}

/** 项目动态拼装：WU createdAt/claimedAt/completedAt + deliveredAt，倒序，默认最多 20 条 */
export function buildProjectTimeline(
  wus: PipelineWorkUnit[],
  opts: { deliveredAt?: string | null; agentNameById?: Record<string, string>; limit?: number } = {},
): ProjectTimelineEntry[] {
  const entries: ProjectTimelineEntry[] = [];
  for (const wu of wus) {
    if (wu.createdAt) {
      entries.push({ id: `created:${wu.id}`, at: wu.createdAt, kind: 'created', wuId: wu.id, title: wu.title });
    }
    if (wu.claimedAt) {
      entries.push({
        id: `claimed:${wu.id}`,
        at: wu.claimedAt,
        kind: 'claimed',
        wuId: wu.id,
        title: wu.title,
        actorName: wu.assigneeId ? (opts.agentNameById?.[wu.assigneeId] ?? null) : null,
      });
    }
    if (wu.completedAt) {
      entries.push({ id: `completed:${wu.id}`, at: wu.completedAt, kind: 'completed', wuId: wu.id, title: wu.title, status: wu.status });
    }
  }
  if (opts.deliveredAt) {
    entries.push({ id: 'delivered', at: opts.deliveredAt, kind: 'delivered' });
  }
  return entries
    .filter(e => !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, opts.limit ?? 20);
}

/** 动态时间戳：MM-dd HH:mm（本地时区） */
export function formatTimelineTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
