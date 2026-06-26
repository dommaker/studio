/**
 * Integration Rollback — B58: Phase Gate 验证 + 局部重跑
 *
 * Integration 失败后：诊断失败类型 → 定位问题 step → 级联 rollback → 重调度
 *
 * 核心函数：
 * - parseIntegrationFailureType: error string → 结构化 failureType
 * - mapAffectedFilesToSteps: affected files → GoalExecution step indices
 * - rollbackToIntegrationStep: 主入口 — 诊断 + rollback + knowledgeBus
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { execSync } from 'child_process';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import { parseJsonField } from './goal-crud.js';

// ─── Types ───

export type IntegrationFailureType =
  | 'merge_conflict'
  | 'tsc_error'
  | 'test_failure'
  | 'missing_branch'
  | 'empty_merge'
  | 'unknown';

/** Structured return from runIntegrationInCode (P1) */
export interface IntegrationResult {
  success: boolean;
  failureType?: IntegrationFailureType;
  error?: string;
  failedBranch?: string;
  affectedFiles?: string[];
}

export interface RollbackParams {
  goalId: string;
  integrationExecutionId: string;
  failureType: IntegrationFailureType;
  error: string;
  affectedFiles: string[];
  worktree: string;
}

export interface RollbackResult {
  rolledBackSteps: number[];
  blocked: boolean;
  reason?: string;
}

// ─── Constants ───

const MAX_RETRIES = 3;

// ─── parseIntegrationFailureType ───

/**
 * Parse Integration error string into structured failure type.
 * Matches patterns from runIntegrationInCode return values.
 */
export function parseIntegrationFailureType(error: string): IntegrationFailureType {
  if (!error || error.trim().length === 0) return 'unknown';

  if (/merge conflict/i.test(error) || /CONFLICT/i.test(error)) return 'merge_conflict';
  if (/tsc failed/i.test(error) || /tsc.*error/i.test(error)) return 'tsc_error';
  if (/impacted tests failed/i.test(error) || /test.*failed/i.test(error)) return 'test_failure';
  if (/no step branches found/i.test(error) || /missing.*branch/i.test(error)) return 'missing_branch';

  return 'unknown';
}

// ─── extractAffectedFiles ───

/**
 * Extract file paths from tsc/test error messages.
 * tsc: "src/foo.ts(10,5): error TS2322"
 * test: "FAIL src/__tests__/foo.test.ts"
 */
export function extractAffectedFiles(error: string): string[] {
  const files = new Set<string>();

  // tsc pattern: file.ts(line,col): error
  const tscMatches = error.matchAll(/(\S+\.ts)\(\d+,\d+\)/g);
  for (const m of tscMatches) {
    files.add(m[1]);
  }

  // test failure pattern: FAIL path/to/test.ts or file path in test output
  const testMatches = error.matchAll(/(?:FAIL|Error:)\s+(\S+\.test\.\S+)/g);
  for (const m of testMatches) {
    files.add(m[1]);
  }

  // generic .ts file references (fallback for less structured errors)
  if (files.size === 0) {
    const genericMatches = error.matchAll(/(\S+\.ts)(?:\s|$|:)/g);
    for (const m of genericMatches) {
      if (!m[1].includes('node_modules') && !m[1].includes('dist/')) {
        files.add(m[1]);
      }
    }
  }

  return [...files];
}

// ─── mapAffectedFilesToSteps ───

/**
 * Map affected file paths to GoalExecution step indices.
 * Uses `git log --all` to find which task branch modified each file,
 * then matches branch name → execution ID → step index.
 */
export async function mapAffectedFilesToSteps(
  goalId: string,
  affectedFiles: string[],
  worktree: string,
): Promise<number[]> {
  if (affectedFiles.length === 0) return [];

  const allDoneChildren = await prisma.goalExecution.findMany({
    where: { parentId: goalId, status: 'done' },
    select: { id: true, metadata: true },
  });
  const succeededExecs = allDoneChildren.filter(c => {
    const m = c.metadata ? JSON.parse(c.metadata) : {};
    return m.stepIndex !== 999;
  });

  if (succeededExecs.length === 0) return [];

  // Build execId → stepIndex map
  const execToStep = new Map(succeededExecs.map(e => {
    const m = e.metadata ? JSON.parse(e.metadata) : {};
    return [e.id, m.stepIndex ?? 0];
  }));
  const matchedSteps = new Set<number>();

  for (const file of affectedFiles) {
    try {
      // Find all task branches that modified this file
      const branches = execSync(
        `git log --all --format="%D" -- "${file}" 2>/dev/null | grep -oP 'task/[^,\\s]+' | sort -u`,
        { cwd: worktree, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' },
      ).trim();

      if (!branches) continue;

      for (const branchLine of branches.split('\n').filter(Boolean)) {
        const branchName = branchLine.trim();
        // Extract execution ID from branch name: task/<execId> or task/<prefix>-<execId>
        for (const [execId, stepIndex] of execToStep) {
          if (branchName.includes(execId)) {
            matchedSteps.add(stepIndex);
          }
        }
      }
    } catch {
      // git log failed for this file — skip
      logger.warn('[IntegrationRollback] git log failed for file', { file });
    }
  }

  return [...matchedSteps].sort((a, b) => a - b);
}

/**
 * Internal: map affected files to steps using a pre-built execToStep map.
 * Used by rollbackToIntegrationStep to avoid duplicate prisma query.
 */
async function mapAffectedFilesToStepsFromExecs(
  affectedFiles: string[],
  worktree: string,
  execToStep: Map<string, number>,
): Promise<number[]> {
  if (affectedFiles.length === 0 || execToStep.size === 0) return [];

  const matchedSteps = new Set<number>();

  for (const file of affectedFiles) {
    try {
      const output = execSync(
        `git log --all --format="%D" -- "${file}" 2>/dev/null || true`,
        { cwd: worktree, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' },
      );

      for (const line of output.split('\n')) {
        for (const [execId, stepIndex] of execToStep) {
          if (line.includes(`task/${execId}`)) {
            matchedSteps.add(stepIndex);
          }
        }
      }
    } catch {
      logger.warn('[IntegrationRollback] git log failed for file', { file });
    }
  }

  return [...matchedSteps].sort((a, b) => a - b);
}

// ─── cascadeDownstreamSteps ───

/**
 * Given a set of step indices to rollback, find all downstream dependent steps
 * that also need rollback (transitively).
 */
async function cascadeDownstreamSteps(
  goalId: string,
  initialSteps: number[],
): Promise<number[]> {
  const goal = await prisma.goalExecution.findUnique({ where: { id: goalId }, select: { metadata: true } });
  const goalMeta = goal?.metadata ? JSON.parse(goal.metadata) : {};
  const plan = goalMeta.plan;

  if (!plan || plan.status !== 'approved') return initialSteps;

  const steps = plan.steps || [];

  if (steps.length === 0) return initialSteps;

  // Build reverse dependency map: stepIndex → steps that depend on it
  const reverseDeps = new Map<number, number[]>();
  for (const step of steps) {
    for (const dep of step.dependencies) {
      const dependents = reverseDeps.get(dep) || [];
      dependents.push(step.index);
      reverseDeps.set(dep, dependents);
    }
  }

  // BFS from initial steps
  const allSteps = new Set(initialSteps);
  const queue = [...initialSteps];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = reverseDeps.get(current) || [];
    for (const dep of dependents) {
      if (!allSteps.has(dep)) {
        allSteps.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...allSteps].sort((a, b) => a - b);
}

// ─── rollbackToIntegrationStep ───

/**
 * Main entry: Integration 失败后 rollback 问题 step + 级联下游 + 重调度。
 *
 * 流程:
 * 1. 检查 retryCount — 超过 MAX_RETRIES → mark blocked
 * 2. 定位问题 step (mapAffectedFilesToSteps)
 * 3. 级联下游依赖 step (cascadeDownstreamSteps)
 * 4. Reset 所有目标 step: succeeded → pending, 递增 retryCount, 注入诊断信息
 * 5. Delete integration step (999)
 * 6. Reset goal status → executing
 * 7. Record gate failure → knowledgeBus
 */
export async function rollbackToIntegrationStep(
  params: RollbackParams,
): Promise<RollbackResult> {
  const { goalId, integrationExecutionId, failureType, error, affectedFiles, worktree } = params;

  // Step 1: Query ALL succeeded executions + identify affected steps
  const allDoneChildren = await prisma.goalExecution.findMany({
    where: { parentId: goalId, status: 'done' },
    select: { id: true, metadata: true, retryCount: true },
  });
  const allSucceeded = allDoneChildren.filter(c => {
    const m = c.metadata ? JSON.parse(c.metadata) : {};
    return m.stepIndex !== 999;
  });

  const execToStep = new Map(allSucceeded.map(e => {
    const m = e.metadata ? JSON.parse(e.metadata) : {};
    return [e.id, m.stepIndex ?? 0];
  }));
  const targetSteps = await mapAffectedFilesToStepsFromExecs(affectedFiles, worktree, execToStep);

  if (targetSteps.length === 0) {
    logger.warn('[IntegrationRollback] No steps identified for affected files', {
      goalId, affectedFiles,
    });
    await safeDeleteIntegrationStep(integrationExecutionId);
    await prisma.goalExecution.update({
      where: { id: goalId },
      data: { status: 'active', completedAt: null },
    });
    return { rolledBackSteps: [], blocked: false, reason: 'no_steps_identified' };
  }

  // Step 2: Cascade to downstream
  const allSteps = await cascadeDownstreamSteps(goalId, targetSteps);

  // Step 3: Filter executions to all steps (direct + cascaded)
  const executions = allSucceeded.filter(e => {
    const m = e.metadata ? JSON.parse(e.metadata) : {};
    return allSteps.includes(m.stepIndex ?? 0);
  });

  // Step 4: Check retryCount — if any exceeds MAX_RETRIES → blocked
  const overLimit = executions.find(e => e.retryCount >= MAX_RETRIES);
  if (overLimit) {
    const overMeta = overLimit.metadata ? JSON.parse(overLimit.metadata) : {};
    logger.warn('[IntegrationRollback] Rollback blocked — retry limit reached', {
      goalId, stepIndex: overMeta.stepIndex, retryCount: overLimit.retryCount,
    });
    await prisma.goalExecution.update({
      where: { id: goalId },
      data: { status: 'blocked' },
    });
    return {
      rolledBackSteps: [],
      blocked: true,
      reason: `Step ${overMeta.stepIndex} retryCount ${overLimit.retryCount} >= MAX_RETRIES ${MAX_RETRIES}`,
    };
  }

  // Step 5: Reset each step to unassigned
  const diagnosis = buildDiagnosisMessage(failureType, error, affectedFiles);

  for (const exec of executions) {
    const eMeta = exec.metadata ? JSON.parse(exec.metadata) : {};
    const input = eMeta.input || {};
    await prisma.goalExecution.update({
      where: { id: exec.id },
      data: {
        status: 'unassigned',
        retryCount: exec.retryCount + 1,
        metadata: JSON.stringify({
          ...eMeta,
          error: JSON.stringify({ message: diagnosis, timestamp: Date.now() }),
          input: {
            ...input,
            _integrationDiagnosis: {
              failureType,
              error: error.slice(0, 500),
              affectedFiles,
              rollbackRound: exec.retryCount + 1,
            },
          },
        }),
        claimedAt: null,
        completedAt: null,
        timeoutAt: null,
      },
    });
    const stepMeta = exec.metadata ? JSON.parse(exec.metadata) : {};
    logger.info('[IntegrationRollback] Step reset to unassigned', {
      executionId: exec.id, stepIndex: stepMeta.stepIndex, newRetryCount: exec.retryCount + 1,
    });
  }

  // Step 6: Delete integration step
  await safeDeleteIntegrationStep(integrationExecutionId);

  // Step 7: Reset goal status
  await prisma.goalExecution.update({
    where: { id: goalId },
    data: { status: 'active', completedAt: null },
  });

  // Step 8: Record gate failure → knowledgeBus
  try {
    await knowledgeBus.recordPattern({
      type: 'incident',
      title: `[Integration] ${failureType}: ${goalId.slice(0, 8)}`,
      content: [
        `source_goal: ${goalId}`,
        `failure_type: ${failureType}`,
        `error: ${error.slice(0, 300)}`,
        `affected_files: ${affectedFiles.join(', ')}`,
        `rolled_back_steps: ${allSteps.join(', ')}`,
        `rollback_round: ${executions[0]?.retryCount + 1 || 1}`,
      ].join('\n'),
      severity: 'warning',
      source: 'executor',
      timestamp: Date.now(),
      context: { goalId, failureType, affectedFiles: affectedFiles.join(',') },
    });
  } catch (e) {
    logger.warn('[IntegrationRollback] knowledgeBus record failed (non-blocking)', { error: String(e) });
  }

  logger.info('[IntegrationRollback] Rollback complete', {
    goalId, rolledBackSteps: allSteps, failureType,
  });

  return { rolledBackSteps: allSteps, blocked: false };
}

// ─── Helpers ───

function buildDiagnosisMessage(
  failureType: IntegrationFailureType,
  error: string,
  affectedFiles: string[],
): string {
  const lines = [
    `## Integration 失败 (Phase Gate)`,
    ``,
    `**失败类型**: ${failureType}`,
    `**影响文件**: ${affectedFiles.join(', ') || 'unknown'}`,
    ``,
    `**错误详情**:`,
    `\`\`\``,
    error.slice(0, 500),
    `\`\`\``,
    ``,
    `请修复上述错误后重新提交。`,
  ];
  return lines.join('\n');
}

async function safeDeleteIntegrationStep(integrationExecutionId: string): Promise<void> {
  try {
    await prisma.goalExecution.delete({ where: { id: integrationExecutionId } });
    logger.info('[IntegrationRollback] Integration step (999) deleted', { integrationExecutionId });
  } catch {
    // May already be deleted or not exist
    try {
      await prisma.goalExecution.update({
        where: { id: integrationExecutionId },
        data: { status: 'unassigned', metadata: JSON.stringify({}), completedAt: null },
      });
    } catch { /* ignore */ }
  }
}
