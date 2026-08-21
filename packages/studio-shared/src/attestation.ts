/**
 * F6 信任证据模型（2026-07-28 内置角色与流水线信任模型分析，决策 1）
 *
 * 信任不再建模为 WU 状态，而是分层证据（attestations），挂在 WU metadata 上：
 *   l1 = 自动验证（测试/lint/typecheck，agent-loop 验证守卫写入）
 *   l2 = agent 评审（评审子 WU 回传，reviewPassed/reviewRejected 写入）
 *   l3 = 人工确认（human-only 端点写入，验收权只在人）
 *
 * 铁律（写纪律，AGENTS.md 约束层同步）：
 *   所有展示/指标只准通过 deriveDisplayState() 一个函数解释证据，
 *   禁止 UI/API/指标各自读 attestations 字段自行判断——口径分叉 = 可读性崩坏。
 *
 * 双轨期约定（F6-a 只加不改 → F6-b 展示切换 → 验证 2-4 周后才停止手写 in_review）：
 *   - 存储 status 照旧手写（门模型继续跑，reviewPassed 守卫依赖它）；
 *   - 派生列与存储状态并存比对，不一致计入 metrics 的派生偏差桶。
 */

/** 证据结论：approved = 该层信任达成；rejected = 该层明确否定（留存痕，后续 approved 覆盖） */
export type AttestationVerdict = 'approved' | 'rejected';

export interface AttestationEntry {
  verdict: AttestationVerdict;
  /** 证据产生者：profile id（l1/l2）、评审子 WU id 引用见 ref、人类用户名（l3） */
  by: string;
  /** ISO 8601 时间 */
  at: string;
  /** 证据种类：'verify'（l1）/ 'agent-review'（l2）/ 'human-confirm'（l3） */
  kind: string;
  /** 简述：验证命令、评审结论、人工备注等 */
  summary?: string;
  /** l2 自评标记（决策 5：频道内除实现者外无人可评，实现者自评兜底，人类待办据此捞出） */
  selfReview?: boolean;
  /** 引用：评审子 WU id / merge commit 等 */
  ref?: string;
}

/** WU 证据台账：每层只留最新一条（事件溯源保有历史，快照只服务查询） */
export interface WuAttestations {
  l1?: AttestationEntry;
  l2?: AttestationEntry;
  l3?: AttestationEntry;
}

/** 看板列词表（与现门模型状态词表一致，派生值也落在这七列） */
export type WuDisplayColumn = 'pending' | 'unassigned' | 'active' | 'in_review' | 'done' | 'blocked' | 'closed';

export interface DerivedWuState {
  /** 展示列：UI 分列/徽章/计数只能用这个值 */
  column: WuDisplayColumn;
  /** 证据达成快照（approved 才算达成；rejected/缺失为 false） */
  evidence: { l1: boolean; l2: boolean; l3: boolean; selfReview: boolean };
  /** 人类待办 = 活已干完但人未确认（手写 in_review，或 done 且证据模型已介入但缺 l3）。
   *  注意：pending（扩范围待确认人闸）不计入 needsHuman--pending 是「待确认」而非「待人工」，
   *  口径与工单类型认领属性一致（pending -> 人确认后才进 frontier 可认领）。 */
  needsHuman: boolean;
  /** 活干完没（所有权口径，与信任无关）= 存储状态 done/closed。进度统计用这个，不要用 column */
  workFinished: boolean;
  /** 证据模型是否已介入本 WU（有任何一层记录）。false = 存量 legacy，按存储状态原样展示 */
  hasAttestations: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseEntry(v: unknown): AttestationEntry | undefined {
  if (!isRecord(v)) return undefined;
  if (v.verdict !== 'approved' && v.verdict !== 'rejected') return undefined;
  if (typeof v.by !== 'string' || typeof v.at !== 'string') return undefined;
  return {
    verdict: v.verdict,
    by: v.by,
    at: v.at,
    kind: typeof v.kind === 'string' ? v.kind : 'unknown',
    ...(typeof v.summary === 'string' ? { summary: v.summary } : {}),
    ...(v.selfReview === true ? { selfReview: true } : {}),
    ...(typeof v.ref === 'string' ? { ref: v.ref } : {}),
  };
}

/**
 * 安全解析 WU metadata 中的 attestations（metadata 可为对象或 JSON 字符串；
 * 损坏/缺字段一律容忍，返回 undefined = 证据模型未介入）。
 */
export function parseAttestations(metadata: unknown): WuAttestations | undefined {
  let meta = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(meta)) return undefined;
  const raw = meta.attestations;
  if (!isRecord(raw)) return undefined;
  const out: WuAttestations = {};
  const l1 = parseEntry(raw.l1);
  const l2 = parseEntry(raw.l2);
  const l3 = parseEntry(raw.l3);
  if (l1) out.l1 = l1;
  if (l2) out.l2 = l2;
  if (l3) out.l3 = l3;
  if (!l1 && !l2 && !l3) return undefined;
  return out;
}

/** 追加/覆盖一层证据（返回新对象，不改原值；每层只留最新一条） */
export function withAttestation(
  existing: WuAttestations | undefined,
  level: 'l1' | 'l2' | 'l3',
  entry: AttestationEntry,
): WuAttestations {
  return { ...(existing ?? {}), [level]: entry };
}

/**
 * 唯一派生口径：WU 存储状态 + 证据台账 → 展示列/证据快照/人类待办。
 *
 * 派生规则（双轨期）：
 *   - 所有权状态（pending/unassigned/active/blocked/closed）原样透传——这些不是信任状态；
 *     pending（#126 待确认人闸）= 扩范围单创建落点，列入「待确认」而非「待人工」--人确认后进 frontier，活未开干故不计 needsHuman；
 *   - 手写 in_review → in_review（门模型仍在跑，存储值保持权威）；
 *   - done 且无证据（legacy 存量）→ done 原样透传；
 *   - done 且证据已介入 → l3 approved 才出 done 列，否则回 in_review 列（等人工确认）。
 *     l3 是最终闸门：人工直接验收（无 l2）同样出 done 列，l2 缺失不阻断人工。
 */
export function deriveDisplayState(input: { status: string; metadata?: unknown }): DerivedWuState {
  const attestations = parseAttestations(input.metadata);
  const l1 = attestations?.l1?.verdict === 'approved';
  const l2 = attestations?.l2?.verdict === 'approved';
  const l3 = attestations?.l3?.verdict === 'approved';
  const selfReview = attestations?.l2?.selfReview === true;
  const evidence = { l1, l2, l3, selfReview };

  let column: WuDisplayColumn;
  switch (input.status) {
    case 'pending':
    case 'unassigned':
    case 'active':
    case 'blocked':
    case 'closed':
      column = input.status;
      break;
    case 'in_review':
      column = 'in_review';
      break;
    case 'done':
      column = !attestations ? 'done' : l3 ? 'done' : 'in_review';
      break;
    default:
      // 未知状态不猜，按 active 兜底展示（不放大异常数据）
      column = 'active';
      break;
  }

  // pending 不计 needsHuman（#280）：pending 是「待确认」人闸（扩范围单创建落点，活未开干），
  // 与 in_review（活已干完等审查）/ done 缺 l3（活已干完等人工验收）语义不同。
  const needsHuman =
    input.status === 'in_review' ||
    (input.status === 'done' && attestations !== undefined && !l3);

  const workFinished = input.status === 'done' || input.status === 'closed';

  return { column, evidence, needsHuman, workFinished, hasAttestations: attestations !== undefined };
}
