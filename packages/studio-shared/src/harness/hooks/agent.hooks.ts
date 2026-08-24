/**
 * Agent Execution Phase Hooks
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkBeforeExecution, getTraceCollector } from '@dommaker/harness';
import type { ConstraintContext, HookDefinition } from '@dommaker/harness';
import { runHook } from './config';
import { formatConstraintsForPrompt } from '../prompt-injection';

/** 延迟取 bootstrap 合并约束（含 custom-constraints.yml），避免与 bootstrap→register→hooks 的静态循环依赖 */
async function getMergedConstraints() {
  const { getHarness } = await import('../runtime/bootstrap');
  return getHarness()?.mergedConstraints ?? null;
}

export async function beforeAgentExecute(ctx: ConstraintContext & {
  hasWorktree?: boolean;
  worktreePath?: string;
}): Promise<void> {
  await runHook('beforeAgentExecute', async () => {
    await checkBeforeExecution({
      operation: 'code_implementation',
      taskDescription: ctx.taskDescription,
      projectPath: ctx.projectPath,
      hasWorktree: ctx.hasWorktree,
      worktreePath: ctx.worktreePath,
      hasVerificationEvidence: (ctx as any).hasVerificationEvidence,
      hasRequirement: (ctx as any).hasRequirement,
      hasSingleTask: (ctx as any).hasSingleTask,
      hasRequirementReview: (ctx as any).hasRequirementReview,
      hasExternalCapabilityVerification: (ctx as any).hasExternalCapabilityVerification,
      hasTest: (ctx as any).hasTest,
      hasTwoStageReview: (ctx as any).hasTwoStageReview,
      hasRootCauseInvestigation: (ctx as any).hasRootCauseInvestigation,
      hasFailingTest: (ctx as any).hasFailingTest,
    }, await getMergedConstraints());
  });
}

export function buildAgentConstraintPrompt(ctx: ConstraintContext): string {
  const projectPath = ctx.projectPath || process.cwd();
  // Inject all applicable harness constraints by role (full text, not truncated)；
  // 渲染走 harness renderConstraintsByTrigger（A3），按项目生效集渲染。
  const harnessConstraints = formatConstraintsForPrompt('executor', { projectRoot: projectPath });

  // Runtime dedup: 约束正文已在仓内文档正本中时注入短引用而非全量正文，避免双份注入。
  // 新模型（docs/adr/2026-08-21-agent-docs-placement-model.md）：正本 = AGENTS.md
  // PRESERVE:governance 段；旧模型：CLAUDE.md HARNESS_CONSTRAINTS 段。
  let constraintSection: string;
  const readSafe = (p: string): string | null => {
    try {
      return existsSync(p) ? readFileSync(p, 'utf-8') : null;
    } catch {
      return null;
    }
  };
  const agentsContent = readSafe(join(projectPath, 'AGENTS.md'));
  const claudeContent = readSafe(join(projectPath, 'CLAUDE.md'));
  if (agentsContent?.includes('<!-- PRESERVE:governance -->')) {
    constraintSection = '## 行为约束\n遵循 AGENTS.md 中「治理契约」（Governance Rules）章节的所有约束。';
  } else if (claudeContent?.includes('<!-- HARNESS_CONSTRAINTS_START -->')) {
    constraintSection = '## 行为约束\n遵循 CLAUDE.md 中「Governance Rules」章节的所有约束。';
  } else {
    constraintSection = harnessConstraints;
  }

  // G2: tool risk awareness — Agent needs to know which tools are dangerous
  const toolRisk = [
    '## 工具风险（sandbox 级别）',
    '',
    '- Level 1-2 (低风险): file:read, search, grep, list — 自由使用',
    '- Level 3 (中风险): file:write, cmd:run — 确认后再执行',
    '- Level 4 (高风险): db:execute, rm, deploy — 必须人工确认',
    '- 不确定工具级别的操作：先查 tool list，不盲目调用',
    '',
  ].join('\n');

  return [constraintSection, toolRisk].filter(Boolean).join('\n');
}

export async function afterAgentComplete(params?: {
  executionId?: string;
  success?: boolean;
  sessionCount?: number;
}): Promise<void> {
  await runHook('afterAgentComplete', async () => {
    const collector = getTraceCollector();
    const traceBase = {
      agentType: 'claude',
      phase: 'execution',
      operation: 'code_implementation',
      message: params?.success
        ? `Agent completed in ${params.sessionCount ?? '?'} sessions`
        : `Agent execution recorded`,
      details: params,
    };
    if (params?.success) {
      collector.recordPass('agent_execution', 'guideline', traceBase);
    } else {
      collector.recordFail('agent_execution', 'guideline', traceBase);
    }
  });
}

/**
 * 导出即注册（C1）：buildAgentConstraintPrompt 是同步直接调用助手，不进管线，
 * 无 HookDefinition（与声明表一致）。
 */
export const agentHookDefinitions: HookDefinition[] = [
  {
    name: 'beforeAgentExecute',
    phase: 'before',
    execute: async (ctx: any) => {
      await beforeAgentExecute(ctx);
      return { passed: true };
    },
  },
  {
    name: 'afterAgentComplete',
    phase: 'after',
    execute: async (params: any) => {
      await afterAgentComplete(params);
      return { passed: true };
    },
  },
];
