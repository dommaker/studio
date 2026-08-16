/**
 * MCP Tools — 安全约束
 *
 * T3 拆分：自 tools.ts 原样提取（checkConstraint / checkGuardrail / getSandboxLevel）。
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
      const { constraintService } = await import('@dommaker/studio-shared');
      const context = { ...input.context, operation: input.operation };
      const result = await constraintService.checkConstraints(context);
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

const checkGuardrail: RegisteredTool = {
  name: 'checkGuardrail',
  description: '检查输入/输出是否通过安全护栏',
  inputSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', description: '检查方向', enum: ['input', 'output'], default: 'input' },
      content: { type: 'string', description: '要检查的内容' },
      context: { type: 'object', description: '上下文' },
    },
    required: ['content'],
  },
  handler: async (input) => {
    try {
      const { safetyService } = await import('@dommaker/studio-shared');
      const direction = input.direction || 'input';
      const guardrail = direction === 'input'
        ? safetyService.getInputGuardrail()
        : safetyService.getOutputGuardrail();
      const result = guardrail.check(input.content);
      return {
        direction,
        passed: result.safe,
        violations: result.violations,
        content: input.content.slice(0, 200),
        message: result.safe ? 'Guardrail check passed' : `${result.violations.length} violation(s) found`,
      };
    } catch {
      return {
        direction: input.direction || 'input',
        passed: false,
        harnessUnavailable: true,
        message: 'Harness unavailable, guardrail check not performed',
      };
    }
  },
};

const getSandboxLevel: RegisteredTool = {
  name: 'getSandboxLevel',
  description: '获取当前沙箱安全级别配置',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const { safetyService } = await import('@dommaker/studio-shared');
      const sandbox = safetyService.getSandbox();
      return {
        level: `L${sandbox.getLevel()}`,
        description: sandbox.getDescription(),
        message: 'Sandbox configuration retrieved',
      };
    } catch {
      return { level: 'L3', message: 'Sandbox info unavailable (harness not loaded)' };
    }
  },
};

export const safetyTools: RegisteredTool[] = [
  checkConstraint,
  checkGuardrail,
  getSandboxLevel,
];
