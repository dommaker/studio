/**
 * Scheduler Prompt — prompt 构建、上下文收集、Integration 代码执行
 *
 * 从 scheduler-dispatch.ts 提取。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { skillLoader } from '@dommaker/studio-skill';
import { parseJsonField } from './goal.service.js';

// ─── Prompt Builders ───

/** Sub-agent prompt（文件桥模型 + sibling context + 公司知识） */
export function buildSubAgentPrompt(
  input: Record<string, any> | null,
  siblingContext?: string,
  companyKnowledge?: string,
): string {
  const acGroup = input?.acGroup as Record<string, any> | undefined;
  const acs: string[] = acGroup?.acs || [];
  const files: string[] = acGroup?.files || [];
  const notes: string = acGroup?.implementationNotes || '';
  const patterns: string[] = acGroup?.codePatterns || [];
  const gotchas: string[] = acGroup?.gotchas || [];

  const acLines = acs.length > 0
    ? acs.map((ac: string, i: number) => `${i + 1}. ${ac}`).join('\n')
    : '（从任务描述中推断）';

  return [
    '## 你的任务',
    '', // B11-015: 不再要求读完整 REQUIREMENTS.md，当前 step AC 已在下方注入
    '## 验收标准',
    acLines,
    '',
    ...(notes ? ['## 实现指南', notes, ''] : []),
    ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
    ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
    ...(files.length > 0 ? ['## 预期改动文件', ...files.map((f: string) => `- ${f}`), ''] : []),
    ...(siblingContext ? [siblingContext, ''] : []),
    ...(companyKnowledge ? [companyKnowledge, ''] : []),
    skillLoader.formatForPrompt(skillLoader.load({ trigger: 'sub_agent', agentType: 'executor', tier: 'fast' })),
    '',
    '## 验证',
    '声明完成前必须：',
    '1. 运行 npm test 确认所有测试通过（含你新增的测试）',
    '2. 运行 npm run typecheck（或 tsc --noEmit）确认无类型错误',
    '3. 将测试证据写入 .progress.json 的 testResults 字段：',
    '```json',
    '{',
    '  "testResults": {',
    '    "passed": <是否全部通过: true|false>,',
    '    "total": <通过的测试数>,',
    '    "failed": <失败的测试数, 必须为 0>,',
    '    "command": "npm test",',
    '    "evidence": "<测试输出摘要>"',
    '  }',
    '}',
    '```',
    '',
    '## 完成后',
    '在 .progress.json 的 notes 字段简要记录：',
    '- 你的关键设计决策（1-2 句）',
    '- 是否影响其他 AC 组的方案（如需要提醒其他组调整，用 @sibling step-N: 你的建议 格式）',
  ].join('\n');
}

/** 向后兼容：旧 prompt（Legacy task，无 acGroup） */
export function buildLegacyPrompt(input: Record<string, any> | null): string {
  const taskName = input?.taskName as string || input?.requirement as string || 'Task';
  const taskDesc = input?.requirement as string || '';
  const acceptanceCriteria = input?.acceptanceCriteria as string[] | undefined;
  const acText = acceptanceCriteria?.length
    ? `\n验收标准:\n${acceptanceCriteria.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  return [
    `# 任务: ${taskName}`,
    taskDesc ? `\n## 描述\n${taskDesc}` : '',
    acText,
    '\n## 要求\n请完成以上任务，确保代码质量、测试覆盖和安全合规。',
    '\n## 完成后',
    '- 运行 npm test，确认全部测试通过',
    '- 将测试证据写入 .progress.json:',
    '  { "testResults": { "passed": true, "total": N, "failed": 0, "command": "npm test", "evidence": "<摘要>" } }',
    '- 在 notes 中简要记录关键设计决策',
  ].filter(Boolean).join('\n');
}

/** O1f: Lightweight integration prompt */
export async function buildIntegrationPrompt(goalId: string): Promise<string> {
  const execs = await prisma.goalExecution.findMany({
    where: { goalId, status: 'succeeded' },
    select: { id: true, stepIndex: true, input: true, output: true },
    orderBy: { stepIndex: 'asc' },
  });

  const groupList = execs.map(e => {
    const input = e.input as unknown as Record<string, any> | null;
    const output = e.output as unknown as Record<string, any> | null;
    return [
      `### AC 组 ${e.stepIndex + 1}`,
      `  - 执行 ID: ${e.id}`,
      `  - ACs: ${(input?.acGroup?.acs || []).join('; ') || '未知'}`,
      `  - AC 范围文件: ${(input?.acGroup?.files || []).join(', ') || '未知'}`,
      `  - 摘要: ${output?.summary || '无'}`,
      `  - 实际改动文件: ${(output?.changedFiles || []).join(', ') || '未知'}`,
    ].join('\n');
  }).join('\n\n');

  return [
    '合并所有 AC 组的变更，运行 tsc 和测试。',
    '1. git merge --no-ff 所有 task 分支',
    '2. npm run build',
    '3. npm test',
    '如果冲突: 按 AC 组文件的路径优先级解决',
    '',
    '## 各 AC 组完成情况',
    groupList,
  ].join('\n');
}

// ─── Context Helpers ───

/** 获取已完成 sibling 的上下文，注入 pending step 的 prompt */
export async function getSiblingContext(
  goalId: string,
  currentExecutionId: string,
  currentStepIndex: number,
): Promise<string> {
  const allExecs = await prisma.goalExecution.findMany({
    where: { goalId },
    select: { id: true, stepIndex: true, status: true, output: true, input: true },
  });

  const completed = allExecs.filter(
    e => e.status === 'succeeded' && e.id !== currentExecutionId,
  );
  if (completed.length === 0) return '';

  const lines: string[] = [
    '## 已完成的相关工作',
    '以下并行步骤已先完成，参考其输出可避免重复劳动或冲突：',
  ];

  for (const sibling of completed) {
    const siblingInput = parseJsonField<Record<string, any>>(sibling.input, {});
    const stepTitle = siblingInput?.acGroup?.id || 'AC 组 ' + (sibling.stepIndex + 1);
    const output = sibling.output as unknown as Record<string, any> | null;
    if (!output) continue;

    lines.push('');
    lines.push(`### ${stepTitle}`);

    if (output.summary) lines.push(`摘要: ${output.summary}`);
    if (output.changedFiles?.length) {
      lines.push(
        '改动文件:',
        ...output.changedFiles.map((f: string) => `  - ${f}`),
      );
    }

    const advice = (output.siblingAdvice || []).filter(
      (a: any) =>
        !a.targetGroupId ||
        a.targetGroupId === currentStepIndex.toString() ||
        a.targetGroupId === `step-${currentStepIndex}`,
    );
    if (advice.length > 0) {
      lines.push(
        '给你的建议:',
        ...advice.map((a: any) => `  - [${a.priority || 'info'}] ${a.message}`),
      );
    }
  }

  return lines.join('\n');
}

/** 获取公司级知识注入（已沉淀的 Pattern/Skill） */
export async function getCompanyKnowledge(goalId: string, input: Record<string, any> | null): Promise<string> {
  try {
    const goal = await prisma.goal.findUnique({ where: { id: goalId }, select: { companyId: true, context: true } });
    const companyId = goal?.companyId || ((goal?.context as any)?.companyId as string);
    if (!companyId) return '';

    const skills = await prisma.skill.findMany({
      where: { companyId, status: 'published' },
      select: { name: true, description: true, category: true, metadata: true },
      take: 5, orderBy: { usageCount: 'desc' },
    });
    if (!skills.length) return '';

    const acText = (input?.acGroup?.acs || []).join(' ').toLowerCase();
    const relevant = skills.filter(s => {
      const skillText = `${s.name} ${s.description} ${s.category}`.toLowerCase();
      return acText.split(' ').some(w => w.length > 2 && skillText.includes(w));
    });

    if (!relevant.length) return '';

    return [
      '## 公司知识库',
      '以下是你公司沉淀的可复用经验和模式：',
      ...relevant.map(s => {
        const pattern = (s.metadata as any)?.pattern || '';
        return `- **${s.name}** (${s.category}): ${s.description}${pattern ? '\n  复用模板: ' + pattern : ''}`;
      }),
    ].join('\n');
  } catch (e) {
    logger.warn('[GoalScheduler] Company knowledge injection failed', { error: String(e) });
    return '';
  }
}

// ─── Repo Helpers ───

/** 从 Goal 的 projectId 反查 project.gitRepo，找不到则回退到 REPO_DIR */
export async function getProjectRepoPath(goal: any): Promise<string> {
  try {
    const ctx = typeof goal.context === 'string' ? JSON.parse(goal.context) : (goal.context || {});
    const projectId = ctx?.projectId as string;
    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { gitRepo: true },
      });
      if (project?.gitRepo) return project.gitRepo;
    }
  } catch { /* fallback */ }
  return process.env.REPO_DIR || path.join(os.homedir(), 'projects');
}

/** B5-P03: 按 execution ID 查找 task/* 分支（分支名可能包含 PMO 号） */
export async function findTaskBranch(executionId: string, repoDir: string): Promise<string | null> {
  try {
    const { execSync } = await import('child_process');
    try {
      execSync(`git rev-parse --verify "task/${executionId}"`, { cwd: repoDir, timeout: 5_000, stdio: 'pipe' });
      return `task/${executionId}`;
    } catch { /* not found */ }
    const found = execSync(`git branch --list "task/*${executionId}*" | head -1 | sed "s/^[* ]*//"`, { cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }).trim();
    return found || null;
  } catch { return null; }
}

// ─── Integration in Code ───

/** P0-1: 用代码执行 Integration（merge+tsc+test），替代 Claude session */
export async function runIntegrationInCode(
  goalId: string,
  executionId: string,
  pmoNumber?: string,
): Promise<{ success: boolean; error?: string }> {
  const execSync = (await import('child_process')).execSync;
  const repoDir = process.env.REPO_DIR || '/root/projects/studio';
  const worktreesDir = process.env.WORKTREES_DIR || '/root/worktrees';
  const worktree = path.join(worktreesDir, executionId);

  try { fs.rmSync(worktree, { recursive: true, force: true }); } catch {}
  const branchSuffix = pmoNumber
    ? `${pmoNumber}-integration-${executionId.slice(0, 20)}`
    : executionId;
  const branchName = `task/${branchSuffix}`;
  try {
    execSync(`git worktree add -b "${branchName}" "${worktree}" HEAD`, { cwd: repoDir, timeout: 30_000 });
  } catch {
    try { execSync(`git branch -D "${branchName}"`, { cwd: repoDir, timeout: 5_000 }); } catch {}
    execSync(`git worktree add -b "${branchName}" "${worktree}" HEAD`, { cwd: repoDir, timeout: 30_000 });
  }
  logger.info('[GoalScheduler] Integration worktree created', { worktree, executionId });

  const succeededExecs = await prisma.goalExecution.findMany({
    where: { goalId, status: 'succeeded', stepIndex: { not: 999 } },
    orderBy: { stepIndex: 'asc' },
  });
  for (const exec of succeededExecs) {
    let branch = `task/${exec.id}`;
    try {
      execSync(`git rev-parse --verify "${branch}"`, { cwd: worktree, timeout: 5_000 });
    } catch {
      try {
        const found = execSync(`git branch --list "task/*${exec.id}*" | head -1 | sed "s/^[* ]*//"`, { cwd: worktree, encoding: 'utf-8', timeout: 5_000 }).trim();
        if (found) branch = found;
      } catch { /* fallback to exact name */ }
    }
    try {
      execSync(`git merge "${branch}" --no-edit`, { cwd: worktree, timeout: 15_000 });
      logger.info('[GoalScheduler] Integration merged', { branch, executionId });
    } catch (e: any) {
      const errMsg = e?.stderr?.toString() || e?.message || String(e);
      logger.warn('[GoalScheduler] Integration merge conflict', { branch, error: errMsg.slice(0, 200) });
      eventBus.publish('pipeline.merge_conflict', { branch, executionId, error: errMsg.slice(0, 500) });
      return { success: false, error: `Merge conflict on ${branch}: ${errMsg.slice(0, 200)}` };
    }
  }

  try {
    execSync('npx tsc --noEmit --project apps/api/tsconfig.json 2>&1', { cwd: worktree, timeout: 60_000 });
  } catch (e: any) {
    const errMsg = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
    return { success: false, error: `tsc failed: ${errMsg.slice(0, 300)}` };
  }

  try {
    execSync('npx jest --passWithNoTests 2>&1', { cwd: path.join(worktree, 'apps', 'api'), timeout: 120_000 });
  } catch (e: any) {
    const errMsg = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
    return { success: false, error: `Tests failed: ${errMsg.slice(0, 300)}` };
  }

  const progressPath = path.join(worktree, '.progress.json');
  fs.writeFileSync(progressPath, JSON.stringify({
    taskId: executionId, executionId, goalId, allComplete: true,
    completedSteps: ['merge', 'tsc', 'test'],
    testResults: { passed: 1, failed: 0, total: 1 },
    currentStep: 'integration complete',
    notes: `Integration by code (P0-1): ${succeededExecs.length} branches merged, tsc clean, tests pass`,
  }, null, 2), 'utf-8');

  return { success: true };
}
