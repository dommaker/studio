/**
 * Review Contract — 审查结论（verdict）语义的单一来源
 *
 * 生产审查链路（ReviewDispatcher → review 子 WU → agent-loop parseReviewReport）：
 * reviewer 在输出末行给出 REVIEW_RESULT: {"verdict":"pass"|"reject"|"needs-info",...}
 * verdict/issue 语义以本模块为准，勿在他处再解释 verdict。
 *
 * 2026-08-06：旧管理端点链路（POST /review/diff → review.service.reviewDiff，
 * .review-report.json / overallApproved 二态）已整体删除——端点零真实调用方
 * （web/CLI/scripts 均无），legacy 映射函数（approvedToVerdict/verdictToApproved/
 * deriveVerdictFromLegacyReport/hasBlockingIssues/isReviewVerdict）随之移除。
 */

/** 规范 verdict 三态 */
export type ReviewVerdict = 'pass' | 'reject' | 'needs-info';

/** 规范 issue 严重级别 */
export type ReviewIssueSeverity = 'error' | 'warning' | 'info';

/** 规范 issue 形状（REVIEW_RESULT 行按此要求 reviewer 输出） */
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
