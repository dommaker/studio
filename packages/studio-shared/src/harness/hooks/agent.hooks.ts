/**
 * Agent Execution Phase Hooks
 */

import { checkBeforeExecution, buildConstraintPrompt, getTraceCollector } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';
import { safeCallHook } from './config';

export async function beforeAgentExecute(ctx: ConstraintContext & {
  hasWorktree?: boolean;
  worktreePath?: string;
}): Promise<void> {
  await safeCallHook('beforeAgentExecute', async () => {
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
    });
  });
}

export function buildAgentConstraintPrompt(ctx: ConstraintContext): string {
  const base = buildConstraintPrompt({
    operation: 'code_implementation',
    taskDescription: ctx.taskDescription,
  });

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

  return base ? `${base}\n${toolRisk}` : toolRisk;
}

export async function afterAgentComplete(params?: {
  executionId?: string;
  success?: boolean;
  sessionCount?: number;
}): Promise<void> {
  await safeCallHook('afterAgentComplete', async () => {
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
