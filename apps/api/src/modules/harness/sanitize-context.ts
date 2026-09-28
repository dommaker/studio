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
import type { ConstraintContext } from '@dommaker/harness';

const EVIDENCE_FLAGS = [
  'hasRootCauseInvestigation',
  'hasPlanApproval',
  'hasVerificationEvidence',
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
