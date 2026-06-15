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
import { parseJsonField } from './goal.service.js';
import { skillStore } from '../skills/skill-store.js';

// ─── Skill Template Loading ───

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

interface SkillTemplateMeta {
  name: string;
  description?: string;
  trigger?: string;
  agentTypes?: string[];
  tier?: string;
  status?: string;
}

interface SkillTemplate {
  meta: SkillTemplateMeta;
  template: string;
}

/**
 * Load Skill .md template from disk.
 * Searches <SKILLS_DIR>/<skillName>/SKILL.md structure.
 * Returns {meta, template} or null if not found.
 */
export function loadSkillTemplate(skillName: string): SkillTemplate | null {
  try {
    const filePath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;

    const yaml = match[1];
    const template = match[2].trim();
    const meta: Record<string, unknown> = {};

    for (const line of yaml.split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        meta[key] = val.replace(/^["']|["']$/g, '');
      }
    }

    if (meta.status && meta.status !== 'published') return null;
    return { meta: meta as unknown as SkillTemplateMeta, template };
  } catch {
    return null;
  }
}

/**
 * Build prompt from Skill .md template with placeholder replacement.
 *
 * Supported placeholders:
 *   {{task}}             — task description / AC list
 *   {{constraints}}      — behavior constraints
 *   {{knowledgeContext}} — relevant knowledge
 *   {{capabilities}}     — scanned capability skills
 *
 * Unfilled placeholders are replaced with empty string.
 */
export function buildSkillPrompt(
  skillName: string,
  vars: {
    task?: string;
    constraints?: string;
    knowledgeContext?: string;
    capabilities?: string;
  },
): string {
  const tmpl = loadSkillTemplate(skillName);
  if (!tmpl) return '';

  let result = tmpl.template;
  const replacements: Record<string, string> = {
    '{{task}}': vars.task || '',
    '{{constraints}}': vars.constraints || '',
    '{{knowledgeContext}}': vars.knowledgeContext || '',
    '{{capabilities}}': vars.capabilities || '',
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }

  return result;
}

// ─── Prompt Builders ───

/** Sub-agent prompt（Skill 模板化 + sibling context + 公司知识） */
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

  // Build {{task}} variable
  const taskParts = [
    '## 验收标准', acLines, '',
    ...(notes ? ['## 实现指南', notes, ''] : []),
    ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
    ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
    ...(files.length > 0 ? ['## 预期改动文件', ...files.map((f: string) => `- ${f}`), ''] : []),
  ];

  // Build {{constraints}} variable (verification rules)
  const constraintsParts = [
    '声明完成前必须：',
    '1. 运行测试确认所有测试通过（含你新增的测试）。命令见"环境"章节。',
    '2. 运行类型检查（npx tsc --noEmit）确认无类型错误',
    '3. 将测试证据写入 .progress.json 的 testResults 字段',
    '完成后在 .progress.json notes 中记录关键设计决策',
  ];

  // Assemble via Skill template
  const skillPrompt = buildSkillPrompt('sub-agent-workflow', {
    task: taskParts.join('\n'),
    constraints: constraintsParts.join('\n'),
    knowledgeContext: [siblingContext, companyKnowledge].filter(Boolean).join('\n\n'),
  });

  // Fallback to inline prompt if skill template not found
  if (!skillPrompt) {
    return [
      '## 你的任务', '',
      ...taskParts,
      ...(siblingContext ? [siblingContext, ''] : []),
      ...(companyKnowledge ? [companyKnowledge, ''] : []),
      '',
      '## 验证',
      ...constraintsParts,
    ].join('\n');
  }

  return skillPrompt;
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
    '- 运行测试，确认全部测试通过（命令见"环境"章节）',
    '- 将测试证据写入 .progress.json:',
    '  { "testResults": { "passed": true, "total": N, "failed": 0, "evidence": "<摘要>" } }',
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
    '合并所有 AC 组的变更，运行 tsc 和影响范围测试。',
    '1. git merge --no-ff 所有 task 分支',
    '2. npx tsc --noEmit',
    '3. git diff --name-only 找出变更文件',
    '4. 只跑变更文件对应的测试（同目录 .test.ts），不跑全量',
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

    const skills = skillStore.list(
      { companyId, status: 'published' },
      { take: 5, orderBy: { field: 'usageCount', dir: 'desc' } },
    );
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

/** 从 Goal context 获取仓库路径。优先级：workspaceRepoId → projectId → WorkspaceRepo → fallback */
export async function getProjectRepoPath(goal: any): Promise<string> {
  const ctx = typeof goal.context === 'string' ? JSON.parse(goal.context) : (goal.context || {});

  // Priority 1: Goal 直接绑定 workspaceRepoId
  const workspaceRepoId = ctx?.workspaceRepoId as string;
  if (workspaceRepoId) {
    try {
      const repo = await prisma.workspaceRepo.findUnique({
        where: { id: workspaceRepoId },
        include: { workspace: { select: { workspaceRoot: true } } },
      });
      if (repo?.status === 'active' && repo.workspace) {
        const fullPath = path.join(repo.workspace.workspaceRoot, repo.path);
        if (fs.existsSync(path.join(fullPath, '.git'))) return fullPath;
      }
    } catch { /* fallback */ }
  }

  // Priority 2: Project 关联的 workspaceRepoId 或 gitRepo
  const projectId = ctx?.projectId as string;
  if (projectId) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { gitRepo: true, workspaceRepoId: true },
      });
      if (project?.workspaceRepoId) {
        const repo = await prisma.workspaceRepo.findUnique({
          where: { id: project.workspaceRepoId },
          include: { workspace: { select: { workspaceRoot: true } } },
        });
        if (repo?.status === 'active' && repo.workspace) {
          const fullPath = path.join(repo.workspace.workspaceRoot, repo.path);
          if (fs.existsSync(path.join(fullPath, '.git'))) return fullPath;
        }
      }
      if (project?.gitRepo && fs.existsSync(path.join(project.gitRepo, '.git'))) {
        return project.gitRepo;
      }
    } catch { /* fallback */ }
  }

  // Priority 3: First active WorkspaceRepo
  try {
    const repo = await prisma.workspaceRepo.findFirst({
      where: { status: 'active' },
      include: { workspace: { select: { workspaceRoot: true, status: true } } },
      orderBy: { lastSyncedAt: 'desc' },
    });
    if (repo?.workspace) {
      const fullPath = path.join(repo.workspace.workspaceRoot, repo.path);
      if (fs.existsSync(path.join(fullPath, '.git')) && fs.existsSync(path.join(fullPath, 'package.json'))) {
        logger.info('[SchedulerPrompt] Using first active WorkspaceRepo', { repoPath: fullPath });
        return fullPath;
      }
    }
  } catch { /* fallback */ }

  // Priority 4: Legacy fallback
  const fallbackDir = process.env.REPO_DIR || path.join(os.homedir(), 'projects');
  if (fs.existsSync(path.join(fallbackDir, '.git'))) return fallbackDir;
  logger.error('[SchedulerPrompt] No git repo found', { fallbackDir });
  return fallbackDir;
}

/** B5-P03: 按 execution ID 查找 task/* 分支（分支名可能包含 PMO 号） */
export async function findTaskBranch(executionId: string, repoDir: string): Promise<string | null> {
  try {
    const { execSync } = await import('child_process');
    try {
      execSync(`git rev-parse --verify "task/${executionId}"`, { cwd: repoDir, timeout: 5_000, stdio: 'pipe' });
      return `task/${executionId}`;
    } catch { /* not found */ }
    const found = execSync(`git branch --list "task/*${executionId}*" | head -1 | sed "s/^[*+ ]*//"`, { cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }).trim();
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
    ? `${pmoNumber}-integration-${executionId}`
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
  const mergedBranches: string[] = [];
  const missingBranches: string[] = [];
  for (const exec of succeededExecs) {
    let branch = `task/${exec.id}`;
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify "${branch}"`, { cwd: worktree, timeout: 5_000, stdio: 'pipe' });
      branchExists = true;
    } catch {
      try {
        const found = execSync(`git branch --list "task/*${exec.id}*" | head -1 | sed "s/^[*+ ]*//"`, { cwd: worktree, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }).trim();
        if (found) { branch = found; branchExists = true; }
      } catch { /* not found */ }
    }
    // Fallback: use stored headCommit from execution output
    if (!branchExists) {
      try {
        const output = typeof exec.output === 'string' ? JSON.parse(exec.output) : (exec.output || {});
        const sha = output?.headCommit;
        if (sha && /^[0-9a-f]{40}$/.test(sha)) {
          execSync(`git cat-file -t "${sha}"`, { cwd: worktree, timeout: 5_000, stdio: 'pipe' });
          branch = sha;
          branchExists = true;
          logger.info('[GoalScheduler] Using stored headCommit for merge', { executionId: exec.id, sha });
        }
      } catch { /* SHA not available or not valid */ }
    }
    if (!branchExists) {
      missingBranches.push(`step ${exec.stepIndex} (${exec.id.slice(0, 8)})`);
      continue;
    }
    try {
      execSync(`git merge "${branch}" --no-ff --no-edit`, { cwd: worktree, timeout: 15_000, stdio: 'pipe' });
      mergedBranches.push(branch);
      logger.info('[GoalScheduler] Integration merged', { branch, executionId });
    } catch (e: any) {
      // Abort merge to leave worktree clean
      try { execSync('git merge --abort', { cwd: worktree, timeout: 5_000, stdio: 'pipe' }); } catch {}
      const errMsg = e?.stderr?.toString() || e?.message || String(e);
      logger.warn('[GoalScheduler] Integration merge conflict', { branch, error: errMsg.slice(0, 200) });
      eventBus.publish('pipeline.merge_conflict', { branch, executionId, error: errMsg.slice(0, 500) });
      return { success: false, error: `Merge conflict on ${branch}: ${errMsg.slice(0, 200)}` };
    }
  }
  if (missingBranches.length > 0 && mergedBranches.length === 0) {
    return { success: false, error: `No step branches found for merge. Missing: ${missingBranches.join(', ')}` };
  }
  if (missingBranches.length > 0) {
    logger.warn('[GoalScheduler] Some step branches missing during integration', { missing: missingBranches, merged: mergedBranches });
  }

  // Copy built dist/ from main repo — worktree packages are gitignored, no dist/
  try {
    const mainPackagesDir = path.join(repoDir, 'packages');
    const wtPackagesDir = path.join(worktree, 'packages');
    if (fs.existsSync(mainPackagesDir) && fs.existsSync(wtPackagesDir)) {
      for (const pkg of fs.readdirSync(mainPackagesDir)) {
        const mainDist = path.join(mainPackagesDir, pkg, 'dist');
        const wtDist = path.join(wtPackagesDir, pkg, 'dist');
        if (fs.existsSync(mainDist) && !fs.existsSync(wtDist)) {
          fs.cpSync(mainDist, wtDist, { recursive: true });
        }
      }
    }
    // Also copy harness dist/ (sibling repo, linked via pnpm overrides)
    const mainHarnessDist = path.join(repoDir, '..', 'harness', 'dist');
    const wtHarnessDist = path.join(worktree, 'harness', 'dist');
    if (fs.existsSync(mainHarnessDist) && !fs.existsSync(wtHarnessDist)) {
      fs.cpSync(mainHarnessDist, wtHarnessDist, { recursive: true });
    }
  } catch (e) {
    logger.warn('[GoalScheduler] Failed to copy workspace dist/', { error: String(e) });
  }

  // Generate Prisma client — pnpm store may have stale types
  try {
    execSync('npx prisma generate 2>&1', { cwd: path.join(worktree, 'packages', 'studio-prisma'), timeout: 30_000 });
  } catch (e: any) {
    const detail = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
    logger.warn('[GoalScheduler] prisma generate failed', { error: detail.slice(0, 500) });
  }

  // 增量 tsc：复制主仓库的 .tsbuildinfo 到 worktree，只检查变更文件
  try {
    const tsbuildinfoSrc = path.join(repoDir, 'apps', 'api', 'tsconfig.tsbuildinfo');
    const tsbuildinfoDst = path.join(worktree, 'apps', 'api', 'tsconfig.tsbuildinfo');
    if (fs.existsSync(tsbuildinfoSrc) && !fs.existsSync(tsbuildinfoDst)) {
      fs.copyFileSync(tsbuildinfoSrc, tsbuildinfoDst);
    }
    execSync('npx tsc --noEmit --incremental --project apps/api/tsconfig.json 2>&1', { cwd: worktree, timeout: 60_000 });
  } catch (e: any) {
    const errMsg = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
    return { success: false, error: `tsc failed: ${errMsg.slice(0, 300)}` };
  }

  // 影响范围测试：只跑变更文件对应的测试，不跑全量
  const { findImpactedTests, runImpactedTests } = await import('./pipeline-utils.js');
  let testResult: { passed: boolean; errors: string[]; testCount: number; method: string } = { passed: true, errors: [], testCount: 0, method: 'skip' };
  try {
    const diffOutput = execSync('git diff HEAD~1 --name-only 2>/dev/null || git diff --name-only 2>/dev/null || echo ""', { cwd: worktree, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' });
    const changedFiles = diffOutput.trim().split('\n').filter(Boolean);
    const impacted = findImpactedTests(changedFiles, worktree);

    if (impacted.testFiles.length > 0) {
      testResult = runImpactedTests(worktree, impacted, 120_000);
      if (!testResult.passed) {
        return { success: false, error: `Impacted tests failed (${testResult.method}, ${testResult.testCount} tests): ${testResult.errors[0]?.slice(0, 300)}` };
      }
    } else {
      logger.info('[GoalScheduler] Integration: no impacted tests found, skipping', { changedFiles: changedFiles.length });
    }
  } catch (e: any) {
    const errMsg = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
    return { success: false, error: `Impact test analysis failed: ${errMsg.slice(0, 300)}` };
  }

  const progressPath = path.join(worktree, '.progress.json');
  fs.writeFileSync(progressPath, JSON.stringify({
    taskId: executionId, executionId, goalId, allComplete: true,
    completedSteps: ['merge', 'tsc', 'test'],
    testResults: { passed: 1, failed: 0, total: testResult.testCount, method: testResult.method },
    currentStep: 'integration complete',
    notes: `Integration by code (P0-1): ${succeededExecs.length} branches merged, tsc clean, ${testResult.method} tests pass (${testResult.testCount} tests)`,
  }, null, 2), 'utf-8');

  return { success: true };
}
