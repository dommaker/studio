/**
 * Worktree Resolver — git worktree 创建 + harness 配置传播 + 文件桥 + 依赖缓存
 *
 * P11-02: Extracted from agent-executor.ts
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { prisma } from '@dommaker/studio-prisma';

import type { AgentTask } from './session-manager.js';
import { execSync } from 'child_process';

/** 检测仓库默认分支名（不猜 main/master） */
function getDefaultBranch(cwd: string): string {
  try {
    const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return remoteHead.replace('refs/remotes/origin/', '');
  } catch { /* no remote HEAD */ }
  for (const branch of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return branch;
    } catch { /* branch doesn't exist */ }
  }
  return 'master';
}

/**
 * 创建 worktree（真 git worktree add）
 */
export async function createWorktree(worktree: string, baseBranch: string, repoDir: string, task?: AgentTask): Promise<void> {
  // Validate repoDir is a git repository
  if (!fsSync.existsSync(path.join(repoDir, '.git'))) {
    throw new Error(`repoDir is not a git repository: ${repoDir}`);
  }

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

  // 创建 git worktree — 分支名必须包含完整 executionId，确保 findTaskBranch 能找到
  const branchName = `task/${path.basename(worktree)}`;
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
 *   2. VPS workspace DB query (prisma.workspace.findFirst) — skipped when hasWorktree=true
 *   3. createWorktree() fallback
 *
 * hasWorktree=true: caller explicitly wants isolated git worktree, skip VPS workspace.
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

  // Priority 2: DB query for VPS workspace (skip when hasWorktree=true)
  const needsWorktree = task.parameters?.hasWorktree === true;
  if (needsWorktree) {
    logger.info('[WorktreeResolver] hasWorktree=true, skipping VPS workspace, creating git worktree');
  } else {
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
  }

  // Priority 3: create git worktree
  const worktree = path.join(worktreesDir, task.executionId);
  const projectRepo = (task.parameters?.repoDir as string) || repoDir;
  const baseBranch = (task.parameters?.baseBranch as string) || getDefaultBranch(projectRepo);
  await createWorktree(worktree, baseBranch, projectRepo, task);
  return worktree;
}

/**
 * 传播 harness 约束 + Claude 权限配置到 worktree
 */
export async function propagateHarnessConfig(worktree: string, taskId: string, executionId: string, repoDir?: string): Promise<void> {
  try {
    // FIX #3: 复制 CLAUDE.md 到 worktree，使 buildAgentConstraintPrompt 去重逻辑生效
    // 主 repo CLAUDE.md 含 <!-- HARNESS_CONSTRAINTS_START --> 标记，
    // buildAgentConstraintPrompt 检测到后只注入短引用，避免全量规则重复
    if (repoDir) {
      const claudeMdSrc = path.join(repoDir, 'CLAUDE.md');
      const claudeMdDst = path.join(worktree, 'CLAUDE.md');
      if (!fsSync.existsSync(claudeMdDst) && fsSync.existsSync(claudeMdSrc)) {
        fsSync.copyFileSync(claudeMdSrc, claudeMdDst);
      }
    }

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
          'local-rag': process.env.LOCAL_RAG_BRIDGE_URL
            ? { type: 'sse', url: process.env.LOCAL_RAG_BRIDGE_URL }
            : {
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
    '## 环境',
    '- 包管理器: pnpm（不是 npm）。安装依赖用 `pnpm install`，不用 `npm install`。',
    '- 依赖已预装（node_modules 通过 hardlink 缓存）。除非 import 报错，否则不需要 install。',
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

// ─── Dependency Cache ───

const DEPS_CACHE_DIR = path.join(os.homedir(), '.cache', 'studio-deps');
const INSTALL_TIMEOUT_MS = 300_000; // 5min
const COPY_TIMEOUT_MS = 60_000; // 1min

/**
 * Compute short hash of lockfile content for cache key.
 * Uses first 16 hex chars of sha256.
 */
function computeLockfileHash(lockfilePath: string): string {
  const content = fsSync.readFileSync(lockfilePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Find lockfile in directory (pnpm-lock.yaml, package-lock.json, yarn.lock).
 */
function findLockfile(dir: string): string | null {
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    const p = path.join(dir, name);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

/**
 * Detect package manager from lockfile name.
 */
function detectPackageManager(lockfilePath: string): 'pnpm' | 'npm' | 'yarn' {
  const base = path.basename(lockfilePath);
  if (base.startsWith('pnpm')) return 'pnpm';
  if (base.startsWith('yarn')) return 'yarn';
  return 'npm';
}

/**
 * Ensure node_modules exists in worktree, using dependency cache.
 *
 * Flow:
 *   1. node_modules/.modules.yaml exists → skip (already installed)
 *   2. Compute sha256(lockfile) as cache key
 *   3. Cache hit: cp -al (hardlink copy, <1s for 375MB)
 *   4. Cache miss: pnpm install --frozen-lockfile, then cache result
 *
 * Expected savings: 30-60s per worktree creation (install time).
 * Disk savings: hardlinks share inodes, no extra disk for cached copies.
 */
export async function ensureDeps(worktree: string, repoDir: string): Promise<void> {
  const nodeModulesPath = path.join(worktree, 'node_modules');
  const modulesYaml = path.join(nodeModulesPath, '.modules.yaml');

  // Already installed — skip
  if (fsSync.existsSync(modulesYaml)) {
    logger.info('[WorktreeResolver] Deps cache: node_modules exists, skipping', { worktree });
    return;
  }

  // Find lockfile (prefer worktree, fall back to repoDir)
  const lockfile = findLockfile(worktree) || findLockfile(repoDir);
  if (!lockfile) {
    logger.warn('[WorktreeResolver] Deps cache: no lockfile found, running bare install', { worktree });
    const pkgManager = fsSync.existsSync(path.join(worktree, 'pnpm-lock.yaml')) ? 'pnpm'
      : fsSync.existsSync(path.join(worktree, 'yarn.lock')) ? 'yarn' : 'npm';
    await execSh(`${pkgManager} install`, { cwd: worktree, timeoutMs: INSTALL_TIMEOUT_MS });
    return;
  }

  const hash = computeLockfileHash(lockfile);
  const cacheDir = path.join(DEPS_CACHE_DIR, hash);
  const cachedModules = path.join(cacheDir, 'node_modules');
  const pkgManager = detectPackageManager(lockfile);
  const installCmd = pkgManager === 'pnpm' ? 'pnpm install --frozen-lockfile'
    : pkgManager === 'yarn' ? 'yarn install --frozen-lockfile'
    : 'npm ci';

  // Cache hit — hardlink copy
  if (fsSync.existsSync(cachedModules)) {
    const startMs = Date.now();
    logger.info('[WorktreeResolver] Deps cache: HIT', { worktree, hash, cacheDir });
    try {
      // cp -al creates hardlinks: <1s for 375MB, zero extra disk
      await execSh(`cp -al "${cachedModules}" "${nodeModulesPath}"`, {
        cwd: worktree, timeoutMs: COPY_TIMEOUT_MS,
      });
      logger.info('[WorktreeResolver] Deps cache: restored from cache', {
        worktree, hash, durationMs: Date.now() - startMs,
      });
      return;
    } catch (e) {
      // Hardlink copy failed (cross-filesystem?) — fall through to install
      logger.warn('[WorktreeResolver] Deps cache: hardlink copy failed, falling back to install', {
        worktree, hash, error: String(e),
      });
    }
  } else {
    logger.info('[WorktreeResolver] Deps cache: MISS', { worktree, hash });
  }

  // Cache miss — install from scratch
  const installStart = Date.now();
  logger.info('[WorktreeResolver] Deps cache: installing', { worktree, command: installCmd });
  try {
    await execSh(installCmd, { cwd: worktree, timeoutMs: INSTALL_TIMEOUT_MS });
    logger.info('[WorktreeResolver] Deps cache: install complete', {
      worktree, durationMs: Date.now() - installStart,
    });
  } catch (e) {
    logger.error('[WorktreeResolver] Deps cache: install failed', { worktree, error: String(e) });
    throw e;
  }

  // Populate cache for future worktrees
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await execSh(`cp -al "${nodeModulesPath}" "${cachedModules}"`, {
      cwd: worktree, timeoutMs: COPY_TIMEOUT_MS,
    });
    logger.info('[WorktreeResolver] Deps cache: populated cache', { worktree, hash, cacheDir });
  } catch (e) {
    // Non-blocking — cache population failure doesn't break the build
    logger.warn('[WorktreeResolver] Deps cache: failed to populate cache', {
      worktree, hash, error: String(e),
    });
  }
}
