/**
 * Agent Execution Phase Hooks
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkBeforeExecution, getTraceCollector } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';
import { runHook } from './config';
import { formatConstraintsForPrompt } from '../prompt-injection';

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
    });
  });
}

export function buildAgentConstraintPrompt(ctx: ConstraintContext): string {
  const projectPath = ctx.projectPath || process.cwd();
  // Inject all applicable harness constraints by role (full text, not truncated)；
  // 渲染走 harness renderConstraintsByTrigger（A3），按项目生效集渲染。
  const harnessConstraints = formatConstraintsForPrompt('executor', { projectRoot: projectPath });

  // Runtime dedup: if CLAUDE.md already has HARNESS_CONSTRAINTS section,
  // inject a reference instead of duplicating the full constraint text.
  // This avoids double injection (CLAUDE.md + system prompt) per Step 8 of the plan.
  let constraintSection: string;
  const claudePath = join(projectPath, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    try {
      const content = readFileSync(claudePath, 'utf-8');
      if (content.includes('<!-- HARNESS_CONSTRAINTS_START -->')) {
        constraintSection = '## 行为约束\n遵循 CLAUDE.md 中「Governance Rules」章节的所有约束。';
      } else {
        constraintSection = harnessConstraints;
      }
    } catch {
      constraintSection = harnessConstraints;
    }
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
