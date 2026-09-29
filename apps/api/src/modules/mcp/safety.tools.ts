/**
 * MCP Tools — 安全约束
 *
 * T3 拆分：自 tools.ts 原样提取（checkConstraint）。
 * #150 A5：SafetyService/constraintService facade 退役，handler 内直连 @dommaker/harness
 * （checkConstraints）。
 * 2026-08：checkGuardrail / getSandboxLevel 随 harness 1.2.0 删除
 * InputGuardrail/OutputGuardrail/Sandbox（ADR-0003）而移除。
 */

import type { RegisteredTool } from './tool-registry.js';
import { ConstraintViolationError } from '@dommaker/harness';
import { sanitizeConstraintContext, downgradeAnnotation, VIOLATION_PARTIAL_VIEW } from '../harness/sanitize-context.js';

// ─── 安全约束 ───

const checkConstraint: RegisteredTool = {
  name: 'checkConstraint',
  description: '检查操作是否违反安全约束（Iron Laws + Guidelines）',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', description: '要检查的操作描述' },
      context: { type: 'object', description: '操作上下文 (roleId, resource, action 等)' },
      constraintIds: { type: 'array', items: { type: 'string' }, description: '指定检查的约束 ID（可选，不传则全量检查）' },
    },
    required: ['operation'],
  },
  handler: async (input) => {
    if (!input.operation?.trim()) {
      return { error: 'operation is required and must be non-empty', allowed: false };
    }
    // #641：剥离调用方自报的证据标志（has*），依赖项由 harness 降级 skip
    const sanitized = sanitizeConstraintContext({ ...input.context, operation: input.operation });
    try {
      const { checkConstraints } = await import('@dommaker/harness');
      const result = await checkConstraints(sanitized.context);
      const violations = [...result.errors, ...result.warnings].filter(r => !r.satisfied);
      return {
        operation: input.operation,
        allowed: result.passed,
        violations,
        ...downgradeAnnotation(sanitized.strippedFlags),
        message: result.passed
          ? 'Constraint check passed'
          : `${violations.length} violation(s) found`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      // block 模式首个 error 级违规即抛：违规是判定数据不是服务故障，
      // 转部分视图返回；harnessUnavailable 只留给真实调不通 harness 的情形
      if (error instanceof ConstraintViolationError) {
        return {
          operation: input.operation,
          allowed: false,
          violations: [error.result],
          ...downgradeAnnotation(sanitized.strippedFlags),
          violationPartialView: VIOLATION_PARTIAL_VIEW,
          message: '1 violation(s) found',
          checkedAt: new Date().toISOString(),
        };
      }
      return {
        operation: input.operation,
        allowed: false,
        harnessUnavailable: true,
        message: 'Harness unavailable, constraint check not performed',
      };
    }
  },
};

export const safetyTools: RegisteredTool[] = [
  checkConstraint,
];
