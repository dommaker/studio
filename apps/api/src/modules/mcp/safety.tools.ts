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
    try {
      if (!input.operation?.trim()) {
        return { error: 'operation is required and must be non-empty', allowed: false };
      }
      const { checkConstraints } = await import('@dommaker/harness');
      const context = { ...input.context, operation: input.operation };
      const result = await checkConstraints(context);
      const violations = [...result.ironLaws, ...result.guidelines].filter(r => !r.satisfied);
      return {
        operation: input.operation,
        allowed: result.passed,
        violations,
        message: result.passed
          ? 'Constraint check passed'
          : `${violations.length} violation(s) found`,
        checkedAt: new Date().toISOString(),
      };
    } catch {
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
