/**
 * Worktree Resolver — git worktree 创建 + harness 配置传播 + 文件桥
 *
 * P11-02: Extracted from agent-executor.ts
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { prisma } from '@dommaker/studio-prisma';

import type { AgentTask } from './session-manager.js';

/**
 * 创建 worktree（真 git worktree add）
 */
export async function createWorktree(worktree: string, baseBranch: string, repoDir: string, task?: AgentTask): Promise<void> {
  // 清理已存在的目录
  try {
    await execSh(`git worktree remove --force "${worktree}" 2>/dev/null || true`, {
      cwd: repoDir,
      timeoutMs: 10_000,
    });
  } catch (e) {
    logger.warn('[WorktreeResolver] Failed to remove worktree, continuing', { error: String(e) });
  }

  try {
    await fs.rm(worktree, { recursive: true, force: true });
  } catch (e) {
    logger.warn('[WorktreeResolver] Failed to clean worktree dir, continuing', { error: String(e) });
  }

  // 创建 git worktree（A3: 使用 PMO number 命名分支）
  const pmoNumber = (task?.parameters?.pmoNumber as string) || '';
  const branchSuffix = pmoNumber
    ? `${pmoNumber}-${path.basename(worktree).slice(0, 30)}`
    : path.basename(worktree).substring(0, 50);
  const branchName = `task/${branchSuffix}`;
  try {
    await execSh(
      `git worktree add -b "${branchName}" "${worktree}" "${baseBranch}"`,
      { cwd: repoDir, timeoutMs: 30_000 },
    );
  } catch (e: any) {
    if (e.message?.includes("already exists")) {
      try {
        await execSh(`git branch -D "${branchName}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 5_000 });
        await execSh(`git worktree add -b "${branchName}" "${worktree}" "${baseBranch}"`, { cwd: repoDir, timeoutMs: 30_000 });
      } catch (e2: any) { throw new Error(`Worktree creation failed after cleanup: ${e2.message}`); }
    } else { throw e; }
  }
  logger.info('[WorktreeResolver] Git worktree created', { worktree, branch: branchName, base: baseBranch, repo: repoDir });
}

/**
 * 3-priority workspace resolution:
 *   1. task.parameters.workspaceRoot (direct path)
 *   2. VPS workspace DB query (prisma.workspace.findFirst)
 *   3. createWorktree() fallback
 */
export async function resolveWorkspace(opts: {
  task: AgentTask;
  worktreesDir: string;
  repoDir: string;
}): Promise<string> {
  const { task, worktreesDir, repoDir } = opts;

  // Priority 1: direct from task parameters
  const directRoot = task.parameters?.workspaceRoot as string | undefined;
  if (directRoot && fsSync.existsSync(directRoot)) {
    logger.info('[WorktreeResolver] Using workspaceRoot from task parameters', { workspaceRoot: directRoot });
    return directRoot;
  }

  // Priority 2: DB query for VPS workspace
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { name: 'VPS', tokenId: null },
      orderBy: { updatedAt: 'desc' },
    });
    if (workspace?.workspaceRoot && fsSync.existsSync(workspace.workspaceRoot)) {
      logger.info('[WorktreeResolver] Using workspace from DB', { workspaceId: workspace.id, workspaceRoot: workspace.workspaceRoot });
      return workspace.workspaceRoot;
    }
  } catch (e) {
    logger.warn('[WorktreeResolver] DB workspace query failed, falling back to createWorktree', { error: String(e) });
  }

  // Priority 3: create git worktree
  const worktree = path.join(worktreesDir, task.executionId);
  const projectRepo = (task.parameters?.repoDir as string) || repoDir;
  const baseBranch = (task.parameters?.baseBranch as string) || 'main';
  await createWorktree(worktree, baseBranch, projectRepo, task);
  return worktree;
}

/**
 * 传播 harness 约束 + Claude 权限配置到 worktree
 */
export async function propagateHarnessConfig(worktree: string, taskId: string, executionId: string): Promise<void> {
  try {
    const harnessDir = path.join(worktree, '.harness');
    if (!fsSync.existsSync(harnessDir)) {
      const templateDir = path.resolve(process.cwd(), '.harness');
      if (fsSync.existsSync(templateDir)) {
        fsSync.mkdirSync(harnessDir, { recursive: true });
        for (const f of ['config.yml', 'checkpoints.yml', 'custom-constraints.yml']) {
          const src = path.join(templateDir, f);
          if (fsSync.existsSync(src)) {
            fsSync.copyFileSync(src, path.join(harnessDir, f));
          }
        }
      } else {
        const harnessPkgDir = path.dirname(require.resolve('@dommaker/harness/package.json'));
        const nodeApiTpl = path.join(harnessPkgDir, 'templates', 'node-api');
        if (fsSync.existsSync(nodeApiTpl)) {
          await execSh(`cp -r "${nodeApiTpl}/.harness" "${harnessDir}" 2>/dev/null || true`, {
            cwd: worktree, timeoutMs: 5000,
          });
        }
      }
    }

    // 写入 .claude/settings.json 使 root daemon 无需 --dangerously-skip-permissions
    const claudeDir = path.join(worktree, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fsSync.existsSync(settingsPath)) {
      fsSync.mkdirSync(claudeDir, { recursive: true });
      fsSync.writeFileSync(settingsPath, JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
        mcpServers: {
          'local-rag': {
            command: 'mcp-local-rag',
            args: [
              '--db-path', process.env.LOCAL_RAG_DB_PATH || '/root/.cache/mcp-local-rag/lancedb',
              '--model-name', process.env.LOCAL_RAG_MODEL || '/root/.cache/huggingface/hub/models--onnx-community--bge-small-zh-v1.5-ONNX/snapshots/main',
            ],
          },
        },
      }, null, 2), 'utf-8');
    }
  } catch { logger.warn('[WorktreeResolver] Harness/Claude config init failed (non-blocking)', { taskId, executionId }); }
}

/**
 * Build shared cache prefix — byte-identical across all worktrees
 * so DeepSeek's prefix cache matches across pipeline agent sessions.
 */
export function buildCachePrefix(repoDir: string): string {
  const lines = [
    '<!-- SHARED_CACHE_PREFIX — DO NOT EDIT — identical across all worktrees -->',
    '',
    '# Project Context (shared)',
    '',
  ];
  try {
    const claudeMd = fsSync.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf-8');
    lines.push(claudeMd);
  } catch {}
  lines.push('');
  return lines.join('\n');
}

/**
 * 写入 REQUIREMENTS.md（session 间共享的 AC 上下文）
 */
export async function writeRequirementsMd(
  worktree: string,
  task: AgentTask,
  acGroup?: Record<string, any>,
): Promise<void> {
  const acs: string[] = acGroup?.acs || [];
  const files: string[] = acGroup?.files || [];
  const notes: string = acGroup?.implementationNotes || '';
  const patterns: string[] = acGroup?.codePatterns || [];
  const gotchas: string[] = acGroup?.gotchas || [];
  const archCtx = acGroup?.architectureContext as Record<string, any> | undefined;

  const isSimple = files.length <= 1 && acs.length <= 3 && gotchas.length <= 2;

  const sections = [
    '# 需求',
    ...(isSimple ? [
      '> ⚡ **简单改动** — Analyst 已验证。直接执行，不探索。',
      '> 步骤：读目标文件 → 按实现指南改 → tsc → npm test → .progress.json',
      '',
    ] : []),
    `## 任务`,
    task.prompt,
    '',
    '## 你负责的验收标准',
    ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. ${ac}`) : ['（从任务描述中推断）']),
    '',
    // ── 架构上下文（Analyst 已探索，你不需要重新读 CLAUDE.md）──
    ...(archCtx ? ['## 架构上下文（Analyst 已探索并验证）', '', '**下面的信息已经过 Analyst 代码探索验证。直接使用，不需要自己重新读文件。** 只在出现矛盾时才验证。', ''] : []),
    ...(archCtx?.functions?.length ? ['### 关键函数', ...archCtx.functions.map((f: string) => `- ${f}`), ''] : []),
    ...(archCtx?.callChain ? ['### 调用链', archCtx.callChain, ''] : []),
    ...(archCtx?.imports?.length ? ['### 需要导入', ...archCtx.imports.map((i: string) => `\`\`\`${i}\`\`\``), ''] : []),
    ...(archCtx?.typesInScope?.length ? ['### 相关类型', ...archCtx.typesInScope.map((t: string) => `- ${t}`), ''] : []),
    ...(archCtx?.dangerZones?.length ? ['### ⚠️ 禁区（不要触碰）', ...archCtx.dangerZones.map((d: string) => `- ${d}`), ''] : []),
    ...(archCtx?.testMock?.length ? ['### 测试 mock 模板', ...archCtx.testMock.map((m: string) => `\`\`\`typescript\n${m}\n\`\`\``), ''] : []),
    ...(archCtx?.verifiedAt ? [`*以上信息验证于 commit ${archCtx.verifiedAt}*`, ''] : []),
    ...(notes ? ['## 实现指南', notes, ''] : []),
    ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
    ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
    ...(files.length > 0 ? ['## 预期改动文件', ...files.map(f => `- ${f}`), ''] : []),
    '## 行为约束',
    '- 完成前必须运行 npm test + type check + lint',
    '- 禁止模糊声明完成',
    '- 每完成一个步骤后立即更新 .progress.json',
    '- 全部 AC 测试通过后才设置 .progress.json allComplete: true',
    '- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）',
    '- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }',
    '- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }',
    '- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节',
  ];

  await fs.writeFile(path.join(worktree, 'REQUIREMENTS.md'), sections.join('\n'), 'utf-8');
}

/**
 * TDD-07: 写入 Analyst 的契约测试到 worktree __tests__/
 *
 * RequirementsDoc.contractTests 包含按 AC 组组织的可执行测试代码。
 * 测试在写入时处于 RED 状态（全部 FAIL），Executor 实现后变为 GREEN。
 */
export async function writeContractTests(
  worktree: string,
  contractTests: Array<{ file: string; content: string }>,
): Promise<void> {
  if (!contractTests?.length) return;

  const testsDir = path.join(worktree, '__tests__');
  await fs.mkdir(testsDir, { recursive: true });

  for (const test of contractTests) {
    const testPath = path.join(worktree, test.file);
    const testDir = path.dirname(testPath);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testPath, test.content, 'utf-8');
    logger.info('[WorktreeResolver] Contract test written', { file: test.file, size: test.content.length });
  }
}
