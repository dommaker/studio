/**
 * PMO 证据台账共享口径（2026-07-30 抽取）：delivery.ts 台账与 progress-rollup.ts
 * 状态翻转共用同一份证据判定，禁止两处各自解释 attestations（铁律同 deriveDisplayState）。
 *
 * 归属口径（#402 逐 WU 并集，2026-08-31 起）：每个 WU 独立解析归属——
 * reqId 解析到已绑定项目的 REQ 则归该项目（显式业务关联权威），否则按创建期
 * 归因戳归属（metadata.pmoId——
 * analysis 派生链的 task WU 无 reqId，仅戳溯源；parser 见 requirements/wu-pmo-attribution.ts）；
 * 两者皆无 = 未归属，不进任何项目台账。单 WU 只归一个项目（reqId 优先，不双计），
 * REQ 链命中不再丢弃同项目的戳归属 WU。
 *
 * 证据口径：
 *   - l1 只对代码类 WU（task/bug/feature/refactor）要求；
 *   - l2 对已完成 WU 要求，但豁免 type==='review' 与人工验收类（MANUAL_GATE_TYPES：
 *     analysis / decision / spec / plan）——与 review-dispatcher.ts 的跳过集对齐：
 *     review 子 WU 自身不再派评审，人工验收类的验收闸是人工确认（L3），diff-only
 *     契约对非代码产物恒 needs-info 转人工纯噪声。若不豁免，这些类型永远不可能
 *     deliverable（规则自相矛盾）。
 *   - l3 对所有已完成 WU 要求（验收权只在人）；
 *   - 代码类 finished WU 另需完整 merge receipt 与目标验证 passed；无验证命令时仅 L3 可替代。
 */
import { deriveDisplayState, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { parseWuPmoId } from '../requirements/index.js';
import { hasCompleteMergeReceipt, MANUAL_GATE_TYPES, parseWuMetadata } from '../workunit/index.js';
import type { DeliveryLeg } from './model.js';
import { matchWuToLeg } from './project-read.js';

export { matchWuToLeg } from './project-read.js';

/** @deprecated 兼容别名；正本在 requirements/wu-pmo-attribution.ts。ARCH-04 拆环后无需 TDZ 转发。 */
export const parseWuMetaPmoId = parseWuPmoId;

/**
 * 证据/归约口径消费的最小 WU 字段集（#410）：summarizeEvidence / partitionSnapshotsByLeg /
 * progress-rollup 完结判定都只读这四个字段——memo（progress-rollup 按事件负载维护的
 * 进程内聚合）与全量 WorkUnitSnapshot 均可喂入，口径不重新解释。
 */
export type EvidenceWuInput = Pick<WorkUnitSnapshot, 'id' | 'status' | 'type' | 'metadata'>;

/** 代码类 WU（与 agent-loop CODE_WORKTREE_TYPES 同集——有专属 worktree 才跑自动验证） */
export const CODE_TYPES = new Set(['task', 'bug', 'feature', 'refactor']);

/** L2 豁免集：ReviewDispatcher 不派自动评审的类型（review + 人工验收类 MANUAL_GATE_TYPES，#471 含 plan）
 *  P2-c：延迟求值——模块顶层展开 MANUAL_GATE_TYPES 会在初始化期解引用 workunit barrel 绑定（环序 TDZ）。 */
let _l2ExemptTypes: Set<string> | null = null;
function l2ExemptTypes(): Set<string> {
  return (_l2ExemptTypes ??= new Set(['review', ...MANUAL_GATE_TYPES]));
}

/** 项目证据汇总（deliverable = 有 WU 且全部完成、三层证据齐、代码 receipt/目标验证可接受） */
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
  /** 代码 WU receipt 缺 merged/mergeCommit/targetBranch，或目标验证 failed/not-run/缺失 */
  mergeMissing: string[];
  /** merge receipt 无目标验证命令且缺 L3 人工确认的代码 WU id */
  verificationUnavailable: string[];
  /** l2 中自评数（决策 5：评审独立性参考，不阻断交付） */
  selfReviewCount: number;
  deliverable: boolean;
}

/**
 * REQ id → 已绑定 PMO 项目 id 映射（projectId 为 null/undefined 的 REQ 不入映射）。
 * #410 起导出：progress-rollup 的 REQ 归属缓存与本模块归属过滤共用同一构建口径。
 */
export function buildReqProjectMap(
  requirements: Array<{ id: string; projectId?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of requirements) {
    if (r.projectId) map.set(r.id, r.projectId);
  }
  return map;
}

/**
 * 逐 WU 归属解析（#402）：reqId 绑定优先，否则创建期归因戳（pmoId ‖ legacy），
 * 都无 → null（未归属）。单 WU 归属唯一，跨项目台账不双计。
 */
function resolveWuProjectId(
  s: Pick<WorkUnitSnapshot, 'reqId' | 'metadata'>,
  reqProjectById: Map<string, string>,
): string | null {
  if (s.reqId) {
    const bound = reqProjectById.get(s.reqId);
    if (bound) return bound;
  }
  return parseWuPmoId(s.metadata);
}

/**
 * 项目关联 WU 归属：逐 WU 解析（reqId 绑定优先 → pmoId 戳兜底），归该项目者计入。
 * #402 前为「reqId 集过滤为空才回退戳」的集合级回退，REQ 链命中即丢弃戳归属 WU
 * （交付统计偏少）；现口径与 progress-rollup 一致。
 */
export function selectProjectSnapshots(
  projectId: string,
  requirements: Array<{ id: string; projectId?: string | null }>,
  index: WorkUnitSnapshot[],
): WorkUnitSnapshot[] {
  const reqProjectById = buildReqProjectMap(requirements);
  return index.filter(s => resolveWuProjectId(s, reqProjectById) === projectId);
}

/** 逐快照过 deriveDisplayState 派生证据齐缺（唯一口径，禁止各自解释 attestations） */
export function summarizeEvidence(snapshots: EvidenceWuInput[]): EvidenceSummary {
  const byStatus = { unassigned: 0, active: 0, inReview: 0, blocked: 0 };
  let finished = 0;
  const l1Missing: string[] = [];
  const l2Missing: string[] = [];
  const l3Missing: string[] = [];
  const mergeMissing: string[] = [];
  const verificationUnavailable: string[] = [];
  let selfReviewCount = 0;

  for (const s of snapshots) {
    if (s.status === 'unassigned') byStatus.unassigned++;
    else if (s.status === 'active') byStatus.active++;
    else if (s.status === 'in_review') byStatus.inReview++;
    else if (s.status === 'blocked') byStatus.blocked++;

    const d = deriveDisplayState({ status: s.status, metadata: s.metadata });
    if (!d.workFinished) continue;
    finished++;
    if (CODE_TYPES.has(s.type)) {
      const receipt = parseWuMetadata(s.metadata).mergeReceipt;
      const verification = receipt?.verification?.status;
      if (!d.evidence.l1 && verification !== 'unavailable') l1Missing.push(s.id);
      if (!hasCompleteMergeReceipt(s.metadata)) {
        mergeMissing.push(s.id);
      } else if (verification === 'unavailable' && !d.evidence.l3) {
        verificationUnavailable.push(s.id);
      }
    }
    // review/analysis 豁免 L2：dispatcher 不派自动评审，验收闸是人工 L3
    if (!l2ExemptTypes().has(s.type) && !d.evidence.l2) l2Missing.push(s.id);
    if (!d.evidence.l3) l3Missing.push(s.id);
    if (d.evidence.selfReview) selfReviewCount++;
  }

  const inFlight = snapshots.length - finished;
  const deliverable = snapshots.length > 0 && inFlight === 0
    && l1Missing.length === 0 && l2Missing.length === 0 && l3Missing.length === 0
    && mergeMissing.length === 0 && verificationUnavailable.length === 0;

  return {
    total: snapshots.length,
    finished,
    inFlight,
    byStatus,
    l1Missing,
    l2Missing,
    l3Missing,
    mergeMissing,
    verificationUnavailable,
    selfReviewCount,
    deliverable,
  };
}

// ============================================
// #113 T7（#106 子票）：WU→腿归属（仅显式多腿项目消费；单腿不走此口径）
// ============================================

/**
 * 多腿分桶：WU 归首个命中的腿（数组序）；全部不命中 = 未分腿公共 WU（shared）。
 * 公共 WU 保守计入每条腿的台账与判定——证据缺口不允许从任何一条腿的交付闸逃逸。
 */
export function partitionSnapshotsByLeg<T extends EvidenceWuInput>(
  legs: DeliveryLeg[],
  snapshots: T[],
): { perLeg: T[][]; shared: T[] } {
  const perLeg: T[][] = legs.map(() => []);
  const shared: T[] = [];
  for (const s of snapshots) {
    const idx = legs.findIndex(leg => matchWuToLeg(s.metadata, leg));
    if (idx >= 0) perLeg[idx].push(s);
    else shared.push(s);
  }
  return { perLeg, shared };
}
