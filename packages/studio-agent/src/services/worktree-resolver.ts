/**
 * Worktree Resolver — git worktree 创建/复用/清理 + harness 配置传播 + 依赖缓存
 *
 * P11-02: Extracted from agent-executor.ts
 * Wave-4: prompt/文件桥内容（buildCachePrefix/writeRequirementsMd/writeContractTests）
 * 移至 runner-briefing.ts；本模块只保留 git/依赖生命周期。
 * （origin/master 曾将 scaffolding 写入同类抽为 worktree-scaffolding.ts；
 *  合并后该拆分产物随 session-manager 簇一并删除，runner-briefing.ts 为文件桥唯一事实源，
 *  ensureDeps 留在本模块。）
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import { execSh, resolveVpsWorkspace } from '@dommaker/studio-shared/node';

import type { AgentTask } from './types.js';
import { execSync } from 'child_process';

/** 检测仓库默认分支名（不猜 main/master） */
export function getDefaultBranch(cwd: string): string {
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
export async function createWorktree(worktree: string, baseBranch: string, repoDir: string, task?: AgentTask, branchName?: string): Promise<void> {
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
  const resolvedBranch = branchName ?? `task/${path.basename(worktree)}`;
  try {
    await execSh(
      `git worktree add -b "${resolvedBranch}" "${worktree}" "${baseBranch}"`,
      { cwd: repoDir, timeoutMs: 30_000 },
    );
  } catch (e) {
    if (e.message?.includes("already exists")) {
      try {
        await execSh(`git branch -D "${resolvedBranch}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 5_000 });
        await execSh(`git worktree add -b "${resolvedBranch}" "${worktree}" "${baseBranch}"`, { cwd: repoDir, timeoutMs: 30_000 });
      } catch (e2) { throw new Error(`Worktree creation failed after cleanup: ${e2.message}`); }
    } else { throw e; }
  }
  logger.info('[WorktreeResolver] Git worktree created', { worktree, branch: branchName, base: baseBranch, repo: repoDir });
  await writeGitExclude(repoDir);
}

/** 工具产物 exclude 规则（写入 .git/info/exclude，git status 不再看到这些产物） */
const GIT_EXCLUDE_PATTERNS = ['.claude/', '.studio/', '.daemon/', '.agent.log', '.harness/'];

async function writeGitExclude(repoDir: string): Promise<void> {
  try {
    const excludePath = path.join(repoDir, '.git', 'info', 'exclude');
    let existing = '';
    try { existing = await fs.readFile(excludePath, 'utf-8'); } catch { /* file may not exist */ }
    const lines = existing.split('\n');
    let changed = false;
    for (const p of GIT_EXCLUDE_PATTERNS) {
      if (!lines.includes(p)) {
        lines.push(p);
        changed = true;
      }
    }
    if (changed) {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.writeFile(excludePath, lines.join('\n') + '\n', 'utf-8');
      logger.info('[WorktreeResolver] Updated git exclude', { repoDir });
    }
  } catch {
    // best-effort: exclude 写入失败绝不阻断 worktree 创建
  }
}

/**
 * 3-priority workspace resolution:
 *   1. task.parameters.workspaceRoot (direct path)
 *   2. VPS workspace lookup — resolveVpsWorkspace() from @dommaker/studio-shared/node
 *      (reads ~/.studio/workspaces/*.json; 'VPS'-name convention owned there) —
 *      skipped when hasWorktree=true
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

  // Priority 2: VPS workspace lookup (skip when hasWorktree=true)
  const needsWorktree = task.parameters?.hasWorktree === true;
  if (needsWorktree) {
    logger.info('[WorktreeResolver] hasWorktree=true, skipping VPS workspace, creating git worktree');
  } else {
    try {
      const ws = await resolveVpsWorkspace();
      if (ws?.workspaceRoot && fsSync.existsSync(ws.workspaceRoot)) {
        logger.info('[WorktreeResolver] Using VPS workspace', { workspaceId: ws.id, workspaceRoot: ws.workspaceRoot });
        return ws.workspaceRoot;
      }
    } catch (e) {
      logger.warn('[WorktreeResolver] VPS workspace lookup failed, falling back to createWorktree', { error: String(e) });
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

      // Studio MCP server URL (provides loadSkill, searchKnowledge, etc.)
      const studioMcpUrl = process.env.STUDIO_MCP_URL || 'http://localhost:13101/api/v1/mcp/sse';

      fsSync.writeFileSync(settingsPath, JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
        mcpServers: {
          'studio': {
            type: 'sse',
            url: studioMcpUrl,
          },
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

// ─── Dependency Cache ───

/** Extract combined error output from execSh rejection (attaches stdout/stderr to Error). */
function extractExecError(e: unknown): string {
  if (e && typeof e === 'object') {
    const rec = e as Record<string, unknown>;
    const stderr = typeof rec.stderr === 'string' ? rec.stderr : '';
    const stdout = typeof rec.stdout === 'string' ? rec.stdout : '';
    const msg = typeof rec.message === 'string' ? rec.message : '';
    return stderr || stdout || msg;
  }
  return String(e);
}

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
  } catch (e: unknown) {
    // Lockfile incompatible — fallback to --force (rewrites lockfile)
    const errMsg = extractExecError(e);
    if (pkgManager === 'pnpm' && errMsg.includes('ERR_PNPM_LOCKFILE_BREAKING_CHANGE')) {
      logger.warn('[WorktreeResolver] Lockfile incompatible, retrying with --force', { worktree });
      await execSh('pnpm install --force', { cwd: worktree, timeoutMs: INSTALL_TIMEOUT_MS });
      logger.info('[WorktreeResolver] Deps cache: --force install complete', {
        worktree, durationMs: Date.now() - installStart,
      });
    } else {
      logger.error('[WorktreeResolver] Deps cache: install failed', { worktree, error: String(e) });
      throw e;
    }
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

// ── B3b-i: WU 专属 worktree（按 WU id 键控，跨 step 复用）──

export interface WuWorktreeInfo {
  worktreePath: string;   // <worktreesDir>/wu-<wuId>
  branch: string;         // task/<wuId>
  baseBranch: string;     // 创建时探测/复用时沿用 metadata 记录
  baseRepo: string;       // 共享 git 仓库根
}

/**
 * B3b-i: 确保 WU 专属 worktree 存在。
 * 同一 WU 多 step 复用（目录含 .git 即视为已创建，不重建）。
 * 创建失败：清理半成品后抛错——调用方走失败分支，绝不允许退回共享目录。
 */
export async function ensureWuWorktree(opts: {
  wuId: string;
  repoDir: string;
  worktreesDir: string;
  baseBranch?: string;
}): Promise<WuWorktreeInfo> {
  const { wuId, repoDir, worktreesDir } = opts;
  const worktreePath = path.join(worktreesDir, `wu-${wuId}`);
  const branch = `task/${wuId}`;

  if (fsSync.existsSync(path.join(worktreePath, '.git'))) {
    logger.info('[WorktreeResolver] Reusing WU worktree', { worktreePath, wuId });
    return { worktreePath, branch, baseBranch: opts.baseBranch || getDefaultBranch(repoDir), baseRepo: repoDir };
  }

  const baseBranch = opts.baseBranch || getDefaultBranch(repoDir);
  try {
    await createWorktree(worktreePath, baseBranch, repoDir, undefined, branch);
  } catch (e) {
    logger.error('[WorktreeResolver] WU worktree creation failed, cleaning up', { worktreePath, wuId, error: String(e) });
    await cleanupFailedWuWorktree(worktreePath, branch, repoDir);
    throw e;
  }
  logger.info('[WorktreeResolver] WU worktree created', { worktreePath, branch, baseBranch, repo: repoDir, wuId });
  return { worktreePath, branch, baseBranch, baseRepo: repoDir };
}

/** ensureWuWorktree 失败兜底：清掉半成品（best-effort，绝不再抛错掩盖原始错误） */
async function cleanupFailedWuWorktree(worktreePath: string, branch: string, repoDir: string): Promise<void> {
  try {
    await execSh(`git worktree remove --force "${worktreePath}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 10_000 });
  } catch { /* best-effort */ }
  try {
    await fs.rm(worktreePath, { recursive: true, force: true });
  } catch { /* best-effort */ }
  try {
    await execSh(`git branch -D "${branch}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 5_000 });
  } catch { /* best-effort */ }
}

/**
 * PMO-b（决策 3）：确保分支存在（幂等）。不存在则从 baseBranch 创建。
 * PMO 分支 = PMO id（project.service create 默认 gitBranch=pmoNumber）。
 */
export async function ensureBranchExists(opts: {
  repoDir: string;
  branch: string;
  baseBranch: string;
}): Promise<void> {
  const { repoDir, branch, baseBranch } = opts;
  try {
    await execSh(`git rev-parse --verify "${branch}"`, { cwd: repoDir, timeoutMs: 5_000 });
    return; // 已存在
  } catch { /* 不存在 → 创建 */ }
  await execSh(`git branch "${branch}" "${baseBranch}"`, { cwd: repoDir, timeoutMs: 10_000 });
  logger.info('[WorktreeResolver] Branch created', { branch, baseBranch, repoDir });
}

/**
 * PMO-b（决策 3）：确保 PMO 集成交合 worktree 存在（<worktreesDir>/pmo-<projectId>）。
 * per-WU 临时分支在这里合入 PMO 分支——冲突集中在单一合并点，
 * 主仓库 checkout 不被打扰（merge 不落在 baseRepo 当前分支上）。
 * 分支不存在先从 baseBranch 创建；worktree 复用按 .git 存在性判断。
 */
export async function ensurePmoIntegrationWorktree(opts: {
  repoDir: string;
  worktreesDir: string;
  projectId: string;
  branch: string;
  baseBranch: string;
}): Promise<{ worktreePath: string }> {
  const { repoDir, worktreesDir, projectId, branch, baseBranch } = opts;
  await ensureBranchExists({ repoDir, branch, baseBranch });
  const worktreePath = path.join(worktreesDir, `pmo-${projectId}`);
  if (fsSync.existsSync(path.join(worktreePath, '.git'))) {
    logger.info('[WorktreeResolver] Reusing PMO integration worktree', { worktreePath, projectId });
    return { worktreePath };
  }
  await execSh(`git worktree add "${worktreePath}" "${branch}"`, { cwd: repoDir, timeoutMs: 30_000 });
  logger.info('[WorktreeResolver] PMO integration worktree created', { worktreePath, branch, projectId });
  return { worktreePath };
}
