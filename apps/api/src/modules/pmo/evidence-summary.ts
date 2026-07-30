/**
 * PMO 证据台账共享口径（2026-07-30 抽取）：delivery.ts 台账与 progress-rollup.ts
 * 状态翻转共用同一份证据判定，禁止两处各自解释 attestations（铁律同 deriveDisplayState）。
 *
 * 归属口径：先按 Requirement.projectId 关联 reqId 集合过滤；为空则回退按
 * metadata.pmoId 归属（analysis 派生链的 task WU 无 reqId，仅 pmoId 溯源）。
 *
 * 证据口径：
 *   - l1 只对代码类 WU（task/bug/feature/refactor）要求；
 *   - l2 对已完成 WU 要求，但豁免 type==='review' 与 type==='analysis'——
 *     与 review-dispatcher.ts:47 的跳过集对齐：review 子 WU 自身不再派评审，
 *     analysis 的验收闸是人工确认（L3），diff-only 契约对非代码产物恒 needs-info
 *     转人工纯噪声。若不豁免，analysis 类 WU 永远不可能 deliverable（规则自相矛盾）；
 *   - l3 对所有已完成 WU 要求（验收权只在人）。
 */
import { deriveDisplayState, type WorkUnitSnapshot } from '@dommaker/studio-shared';

/** 代码类 WU（与 agent-loop CODE_WORKTREE_TYPES 同集——有专属 worktree 才跑自动验证） */
export const CODE_TYPES = new Set(['task', 'bug', 'feature', 'refactor']);

/** L2 豁免集：ReviewDispatcher 不派自动评审的类型（review-dispatcher.ts:47） */
const L2_EXEMPT_TYPES = new Set(['review', 'analysis']);

/** analysis 派生 WU 的 PMO 溯源字段：metadata.pmoId（JSON 字符串，容错解析） */
export function parseWuMetaPmoId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const pmoId = (JSON.parse(metadata) as { pmoId?: unknown }).pmoId;
    return typeof pmoId === 'string' && pmoId.length > 0 ? pmoId : null;
  } catch {
    return null;
  }
}

/** 项目证据汇总（deliverable = 有 WU 且全部完成且三层证据齐） */
export interface EvidenceSummary {
  total: number;
  finished: number;
  inFlight: number;
  /** 在途分布，按 snapshot.status 原始值统计（done/closed 计入 finished，不进 byStatus） */
  byStatus: { unassigned: number; active: number; inReview: number; blocked: number };
  /** 已完成但缺 L1 自动验证的 WU id（仅代码类） */
  l1Missing: string[];
  /** 已完成但缺 L2 agent 评审的 WU id（豁免 review/analysis） */
  l2Missing: string[];
  /** 已完成但缺 L3 人工确认的 WU id */
  l3Missing: string[];
  /** l2 中自评数（决策 5：评审独立性参考，不阻断交付） */
  selfReviewCount: number;
  deliverable: boolean;
}

/**
 * 项目关联 WU 归属：先按 Requirement.projectId 关联 reqId 集合过滤；
 * 为空则回退按 metadata.pmoId 归属（analysis 派生链），口径与 progress-rollup 一致。
 */
export function selectProjectSnapshots(
  projectId: string,
  requirements: Array<{ id: string; projectId?: string | null }>,
  index: WorkUnitSnapshot[],
): WorkUnitSnapshot[] {
  const reqIds = new Set(requirements.filter(r => r.projectId === projectId).map(r => r.id));
  let snapshots = index.filter(s => s.reqId && reqIds.has(s.reqId));
  if (snapshots.length === 0) {
    // analysis 派生链（analysis-handoff）：task WU 无 reqId，仅 metadata.pmoId 溯源
    snapshots = index.filter(s => parseWuMetaPmoId(s.metadata) === projectId);
  }
  return snapshots;
}

/** 逐快照过 deriveDisplayState 派生证据齐缺（唯一口径，禁止各自解释 attestations） */
export function summarizeEvidence(snapshots: WorkUnitSnapshot[]): EvidenceSummary {
  const byStatus = { unassigned: 0, active: 0, inReview: 0, blocked: 0 };
  let finished = 0;
  const l1Missing: string[] = [];
  const l2Missing: string[] = [];
  const l3Missing: string[] = [];
  let selfReviewCount = 0;

  for (const s of snapshots) {
    if (s.status === 'unassigned') byStatus.unassigned++;
    else if (s.status === 'active') byStatus.active++;
    else if (s.status === 'in_review') byStatus.inReview++;
    else if (s.status === 'blocked') byStatus.blocked++;

    const d = deriveDisplayState({ status: s.status, metadata: s.metadata });
    if (!d.workFinished) continue;
    finished++;
    if (CODE_TYPES.has(s.type) && !d.evidence.l1) l1Missing.push(s.id);
    // review/analysis 豁免 L2：dispatcher 不派自动评审，验收闸是人工 L3
    if (!L2_EXEMPT_TYPES.has(s.type) && !d.evidence.l2) l2Missing.push(s.id);
    if (!d.evidence.l3) l3Missing.push(s.id);
    if (d.evidence.selfReview) selfReviewCount++;
  }

  const inFlight = snapshots.length - finished;
  const deliverable = snapshots.length > 0 && inFlight === 0
    && l1Missing.length === 0 && l2Missing.length === 0 && l3Missing.length === 0;

  return {
    total: snapshots.length,
    finished,
    inFlight,
    byStatus,
    l1Missing,
    l2Missing,
    l3Missing,
    selfReviewCount,
    deliverable,
  };
}
