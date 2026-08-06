/**
 * Review Contract — 审查结论（verdict）语义的单一来源
 *
 * 统一两条审查链路的结论契约：
 *   1. 生产链路（ReviewDispatcher → review 子 WU → agent-loop parseReviewReport）：
 *      reviewer 在输出末行给出 REVIEW_RESULT: {"verdict":"pass"|"reject"|"needs-info",...}
 *   2. 管理端点（POST /review/diff → review.service.reviewDiff）：
 *      Claude Code 多立场审查写回 .review-report.json（legacy 形状 {overallApproved: boolean,...}）
 *
 * legacy ↔ canonical 映射（本模块权威定义，勿在他处再解释 verdict）：
 *   overallApproved=true  ⇔ verdict=pass
 *   overallApproved=false ⇔ verdict=reject
 *   needs-info 无 legacy 等价物 —— verdictToApproved 返回 null；
 *   legacy 报告永不产生 needs-info（管理端点上报告缺失/不可解析维持现状的
 *   错误路径：approved=false + error issue，见 review.service.reviewDiff）。
 *
 * 规范裁决规则：任一 severity='error' 的 issue ⇒ verdict 不得为 pass
 * （覆盖 overallApproved=true 的误报；原 review.service FIX #8 收编于此）。
 */

/** 规范 verdict 三态 */
export type ReviewVerdict = 'pass' | 'reject' | 'needs-info';

/** 规范 issue 严重级别（REVIEW_RESULT 行与 .review-report.json 共有词表） */
export type ReviewIssueSeverity = 'error' | 'warning' | 'info';

/** 规范 issue 形状（两条链路的 prompt 均按此要求 reviewer 输出） */
export interface ReviewContractIssue {
  severity: ReviewIssueSeverity;
  message: string;
  file?: string;
  line?: number;
}

/** REVIEW_RESULT 行 JSON 的规范形状（reviewer 输出契约） */
export interface ReviewResultBlock {
  verdict: ReviewVerdict;
  summary?: string;
  issues?: ReviewContractIssue[];
}

/**
 * metadata.reviewReport 落档形状 —— agent-loop parseReviewReport 的返回类型、
 * ReviewDispatcher 路径 B 的消费类型。结构上与 workunit.service 的
 * WorkUnitMetadata.reviewReport 一致（severity 宽松为 string：解析层不丢弃未知级别）。
 */
export interface ParsedReviewReport {
  approved: boolean;
  reason?: string;
  issues?: Array<{ severity: string; message: string }>;
}

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
  return v === 'pass' || v === 'reject' || v === 'needs-info';
}

/** legacy → canonical：legacy 二态只能落在 pass/reject */
export function approvedToVerdict(approved: boolean): Exclude<ReviewVerdict, 'needs-info'> {
  return approved ? 'pass' : 'reject';
}

/** canonical → legacy：pass⇔true / reject⇔false / needs-info 无等价物 → null */
export function verdictToApproved(verdict: ReviewVerdict): boolean | null {
  if (verdict === 'pass') return true;
  if (verdict === 'reject') return false;
  return null;
}

/** 规范阻断判定：任一 error 级 issue ⇒ 阻断（不得 pass） */
export function hasBlockingIssues(issues?: ReadonlyArray<{ severity: string }>): boolean {
  return (issues ?? []).some(i => i.severity === 'error');
}

/**
 * legacy 报告 → 规范 verdict（review.service 的唯一裁决入口，取代原 :160-161 二次解读）。
 * error 级 issue 存在 ⇒ reject（覆盖 overallApproved=true 的误报）；
 * 否则按 overallApproved。issues 缺失 / overallApproved 非 true 一律安全落到 reject。
 */
export function deriveVerdictFromLegacyReport(
  report: { overallApproved?: unknown },
  issues?: ReadonlyArray<{ severity: string }>,
): Exclude<ReviewVerdict, 'needs-info'> {
  if (hasBlockingIssues(issues)) return 'reject';
  return approvedToVerdict(report.overallApproved === true);
}
