/**
 * 证据标志剥离（#641 信任边界）：被检查者不能自证。
 *
 * ConstraintContext 的 has* 证据标志是判定的输入；HTTP/MCP 请求侧自报
 * 「我已验证」等于信任边界洞穿。路由/工具层一律剥离，依赖这些标志的
 * 检查项由 harness 输入契约（harness#182）降级 skip（skipped + skipReason），
 * 即「证据不可得」第三态——服务端能独立取证的项目（docs_freshness 等）
 * 不受影响。
 *
 * 标志清单与 harness ConstraintContext 的 boolean 证据标志字段保持一致
 * （harness 侧类型 = checkers/types.ts ContextEvidenceFlag，未导出值级清单）。
 */
import type { ConstraintCheckResult, ConstraintContext, ConstraintViolationError } from '@dommaker/harness';

const EVIDENCE_FLAGS = [
  'hasRootCauseInvestigation',
  'hasPlanApproval',
  // hasVerificationEvidence 已随 harness 1.15.0（harness#183 证据源重构）从
  // ConstraintContext 退役：no_completion_without_verification 不再吃自报标志，
  // 改读 .harness/evidence 独立链路证据，剥离本字段无所指，故移出清单。
  'hasTest',
  'hasFailingTest',
  'hasReuseCheck',
  'hasSingleTask',
  'hasRequirement',
] as const satisfies readonly (keyof ConstraintContext)[];

export interface SanitizedContext {
  context: ConstraintContext;
  /** 被剥离的证据标志名（按固定序），空数组 = 无剥离 */
  strippedFlags: string[];
}

export function sanitizeConstraintContext(input: ConstraintContext): SanitizedContext {
  const context = { ...input };
  const strippedFlags: string[] = [];
  for (const flag of EVIDENCE_FLAGS) {
    if (context[flag] !== undefined) {
      delete context[flag];
      strippedFlags.push(flag);
    }
  }
  return { context, strippedFlags };
}

/** 响应面降级标注（strippedEvidenceFlags），无剥离时为空对象（响应不带该字段） */
export function downgradeAnnotation(strippedFlags: string[]): { strippedEvidenceFlags?: string[] } {
  return strippedFlags.length > 0 ? { strippedEvidenceFlags: strippedFlags } : {};
}

/**
 * 降级检查项清单（AC2 三态不可混淆）：从检查结果中收 skipped 项，
 * 无论请求体是否带标志，证据不可得的检查项都在响应顶层显式可见。
 */
export function degradedChecksOf(result: ConstraintCheckResult): Array<{ id: string; skipReason?: string }> {
  return [...result.errors, ...result.warnings]
    .filter((r) => r.skipped)
    .map((r) => ({ id: r.id, skipReason: r.skipReason }));
}

/**
 * 违规部分视图（harness 1.15.0 block 模式适配，与 degradedChecks/strippedEvidenceFlags
 * 同族标注 → violationPartialView）。
 *
 * checkConstraints 即抛即停：首个 error 级违规抛 ConstraintViolationError，只携带
 * 该条 ConstraintResult，后续 error 级与全部 warning 级根本没跑。捕获侧不得据此
 * 伪装「harness 不可用」（那留给真实调不通），也不得隐藏违规——转成数据返回并
 * 显式标注这是部分视图。
 */
export const VIOLATION_PARTIAL_VIEW = {
  truncated: true,
  reason: 'checkConstraints block 模式首个 error 级违规即抛：本响应仅含首个违规，后续 error/warning 级检查未执行',
} as const;

/** ConstraintViolationError → ConstraintCheckResult 形状的部分视图（仅首个违规） */
export function violationAsPartialView(error: ConstraintViolationError): ConstraintCheckResult {
  return {
    errors: [error.result],
    warnings: [],
    passed: false,
    warningCount: 0,
  };
}
