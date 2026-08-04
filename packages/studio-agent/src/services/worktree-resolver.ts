/**
 * Worktree Resolver — git worktree 创建/复用/清理 + harness 配置传播 + 共享缓存前缀
 *
 * P11-02: Extracted from agent-executor.ts
 * 2026-08-04: scaffolding 写入（REQUIREMENTS.md / 契约测试 / 依赖缓存）拆至
 * worktree-scaffolding.ts（纯移动），下方门面 re-export 保持导出面不变。
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { FileStore, logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';

const fileStore = new FileStore();

import type { AgentTask } from './session-manager.js';
import { execSync } from 'child_process';

// ── 门面 re-export：scaffolding 写入（纯移动拆出）──
export { writeRequirementsMd, writeContractTests, ensureDeps } from './worktree-scaffolding.js';

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
  } catch (e: any) {
    if (e.message?.includes("already exists")) {
      try {
        await execSh(`git branch -D "${resolvedBranch}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 5_000 });
        await execSh(`git worktree add -b "${resolvedBranch}" "${worktree}" "${baseBranch}"`, { cwd: repoDir, timeoutMs: 30_000 });
      } catch (e2: any) { throw new Error(`Worktree creation failed after cleanup: ${e2.message}`); }
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
      // Look up VPS workspace from FileStore
      let ws: { id: string; workspaceRoot?: string; updatedAt?: string } | null = null;
      try {
        const wsDir = path.join(os.homedir(), '.studio', 'workspaces');
        const entries = await fs.readdir(wsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.json')) continue;
          const data = await fileStore.readJson<any>(path.join(wsDir, e.name));
          if (data && data.name === 'VPS' && !data.tokenId) {
            if (!ws || new Date(data.updatedAt) > new Date(ws.updatedAt)) ws = data;
          }
        }
      } catch { /* no workspace dir */ }
      if (ws?.workspaceRoot && fsSync.existsSync(ws.workspaceRoot)) {
        logger.info('[WorktreeResolver] Using workspace from FileStore', { workspaceId: ws.id, workspaceRoot: ws.workspaceRoot });
        return ws.workspaceRoot;
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

/**
 * Build shared cache prefix — byte-identical across all worktrees
 * so DeepSeek's prefix cache matches across pipeline agent sessions.
 */
export function buildCachePrefix(repoDir: string): string {
  // 探测包管理器
  const pkgManager = fsSync.existsSync(path.join(repoDir, 'pnpm-lock.yaml')) ? 'pnpm'
    : fsSync.existsSync(path.join(repoDir, 'yarn.lock')) ? 'yarn' : 'npm';

  const installCmd = pkgManager === 'pnpm' ? 'pnpm install'
    : pkgManager === 'yarn' ? 'yarn install' : 'npm install';
  const testCmd = pkgManager === 'pnpm' ? 'pnpm test'
    : pkgManager === 'yarn' ? 'yarn test' : 'npm test';

  const lines = [
    '<!-- SHARED_CACHE_PREFIX — DO NOT EDIT — identical across all worktrees -->',
    '',
    '# Project Context (shared)',
    '',
    '## 环境',
    `- 包管理器: ${pkgManager}`,
    `- 安装依赖: \`${installCmd}\``,
    `- 运行测试: \`${testCmd}\``,
    '- 类型检查: `npx tsc --noEmit`',
    '- 依赖已预装（node_modules 通过 hardlink 缓存）。',
    '- **禁止自己跑 install**：node_modules 已存在。如果 import 报错，检查是否是自己修改了代码导致的，修复代码而非安装依赖。',
    '',
  ];
  try {
    const claudeMd = fsSync.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf-8');
    lines.push(claudeMd);
  } catch { /* CLAUDE.md may not exist in the repo */ }
  lines.push('');
  return lines.join('\n');
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
