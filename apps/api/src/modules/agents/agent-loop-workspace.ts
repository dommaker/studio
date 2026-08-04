// AgentLoop 执行根目录/worktree 解析与提交守卫 git 探针 —— 从 agent-loop.ts 原样抽出，行为不变。
import { execSync } from 'child_process';
import { logger, FileStore } from '@dommaker/studio-shared';
import { ensureWuWorktree, ensureBranchExists, getDefaultBranch } from '@dommaker/studio-agent';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import { resolveWorkspaceRoot } from '../workspaces/workspace-store.js';
import { resolvePmoBranchForWU } from '../requirements/pmo-branch-resolver.js';
import { CODE_WORKTREE_TYPES } from './wu-verification.js';
import { isGitRepoRoot, resolveWorktreesDir } from './agent-loop-utils.js';
import { resetUnestablishedSession, type AgentLoopInstanceLike } from './agent-loop-session.js';
import type { StepResult } from './agent-output-parser.js';

/**
 * B3a 归属链：执行根目录解析 — metadata.workspaceRoot（Requirement→PMO gitRepo /
 * 人工回复绑定的直接路径）优先；否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）。
 */
export async function resolveExecutionWorkspaceRoot(wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
  if (typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot.length > 0) {
    return metadata.workspaceRoot;
  }
  return wu.workspaceId ? resolveBoundWorkspaceRoot(wu.workspaceId) : null;
}

/**
 * F6: 解析 WorkUnit 绑定工程的执行根目录（workspace.workspaceRoot）。
 * 记录缺失/无 workspaceRoot/读取失败 → null（保持未绑定的默认行为）。
 */
export async function resolveBoundWorkspaceRoot(workspaceId: string): Promise<string | null> {
  try {
    const root = await resolveWorkspaceRoot(workspaceId);
    if (!root) {
      logger.warn(`[AgentLoop] Bound workspace ${workspaceId} unresolved, falling back to default cwd`);
    }
    return root;
  } catch (err) {
    logger.warn(`[AgentLoop] Workspace resolution failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * B3b-i: review WU 继承父 WU 的 worktree 路径（评审在父 worktree 里执行，能看到 diff）。
 * 父缺失/无 worktreePath/读取失败 → null（维持现状）。
 */
export async function resolveParentWorktreePath(workUnitService: WorkUnitService, wu: WorkUnitData): Promise<string | null> {
  if (!wu.parentId) return null;
  try {
    const parent = await workUnitService.getById(wu.parentId);
    const parentMeta: WorkUnitMetadata = parent?.metadata ? JSON.parse(parent.metadata) : {};
    return typeof parentMeta.worktreePath === 'string' && parentMeta.worktreePath.length > 0
      ? parentMeta.worktreePath
      : null;
  } catch {
    return null;
  }
}

/**
 * B3b-i: 提交守卫/自动验证的 git cwd 解析（recordResult 侧只读消费，不创建）。
 * 代码类 WU 有专属 worktree → 在 worktree 下跑 git status；
 * review WU → 父 WU worktree；否则回退 B3a/F6 的共享根解析。
 */
export async function resolveExecutionCwd(workUnitService: WorkUnitService, wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
  if (CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    return metadata.worktreePath;
  }
  if (wu.type === 'review') {
    const parentWorktree = await resolveParentWorktreePath(workUnitService, wu);
    if (parentWorktree) return parentWorktree;
  }
  return resolveExecutionWorkspaceRoot(wu, metadata);
}

/**
 * §10.5 提交守卫：worktree 是否有未提交改动。
 * git 调用失败返回 false —— 守卫静默跳过，绝不因基础设施故障阻断完成。
 */
export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const out = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** §10.5: 读取 worktree 当前 HEAD hash（失败返回 null —— 无提交监视静默跳过） */
export function readHeadHash(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd, timeout: 5000, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

export interface PreparedWorkspace {
  workspaceRoot: string | null;
  /** worktree 创建失败时的提前返回结果（B1 失败分支） */
  earlyResult?: StepResult;
}

/**
 * agentStep 执行根目录准备（从 agentStep 原样抽出）：
 *
 * F6 → B3a: WorkUnit 绑定工程 → 解析执行根目录，经 parameters.workspaceRoot
 * 传给 agent-runner（resolveWorkspace Priority 1：直接以该目录为 cwd）。
 * metadata.workspaceRoot（B3a 归属链：Requirement→PMO gitRepo / 人工回复绑定）优先；
 * 否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）；都没有 → 不传，保持现有 fallback。
 *
 * B3b-i（决策 D1）：代码类 WU（task/bug/feature/refactor）解析出 git 仓库根后，
 * 不再直接改共享目录 —— 执行 cwd 换成该仓库的专属 worktree
 * （<worktreesDir>/wu-<wuId>，分支 task/<wuId>）。同一 WU 跨 step 复用：
 * 首个 step 创建并把 worktreePath/branch/baseBranch/baseRepo 记入 metadata，
 * 后续 step 经 ensureWuWorktree 按目录存在性复用。创建失败走 B1 失败分支
 * （action='failed' → consecutiveStuck → 3 次 blocked），绝不静默退回共享目录。
 * 解析不出 git 仓库（无绑定根 / 根目录无 .git）→ 维持现状。
 */
export async function prepareExecutionWorkspace(
  deps: { fileStore: FileStore; workUnitService: WorkUnitService; instance: AgentLoopInstanceLike | null },
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  metadataUpdates: Partial<WorkUnitMetadata>,
  newSessionId: string | null,
  traceId: string | undefined,
): Promise<PreparedWorkspace> {
  let workspaceRoot = await resolveExecutionWorkspaceRoot(wu, metadata);
  if (CODE_WORKTREE_TYPES.has(wu.type) && workspaceRoot && isGitRepoRoot(workspaceRoot)) {
    try {
      // PMO-b（决策 3）：WU 归属 PMO → base 从默认分支改为 PMO 分支（分支名 = PMO id），
      // per-WU 临时分支从 PMO 分支拉、向 PMO 分支合（merge-on-review-pass 消费 pmoBranch 落档）。
      // 解析/建支失败回落默认 base，绝不阻断执行。
      let pmoBaseBranch: string | null = null;
      const pmoResolution = await resolvePmoBranchForWU(wu, deps.fileStore).catch(() => null);
      if (pmoResolution) {
        try {
          await ensureBranchExists({
            repoDir: workspaceRoot,
            branch: pmoResolution.branch,
            baseBranch: typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
              ? metadata.worktreeBaseBranch
              : getDefaultBranch(workspaceRoot),
          });
          pmoBaseBranch = pmoResolution.branch;
        } catch (err) {
          logger.warn(`[AgentLoop] PMO branch ensure failed, falling back to default base: ${err instanceof Error ? err.message : String(err)}`, { traceId });
        }
      }
      const info = await ensureWuWorktree({
        wuId: wu.id,
        repoDir: workspaceRoot,
        worktreesDir: resolveWorktreesDir(),
        baseBranch: pmoBaseBranch
          ?? (typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
            ? metadata.worktreeBaseBranch
            : undefined),
      });
      if (metadata.worktreePath !== info.worktreePath) {
        metadataUpdates.worktreePath = info.worktreePath;
        metadataUpdates.worktreeBranch = info.branch;
        metadataUpdates.worktreeBaseBranch = info.baseBranch;
        metadataUpdates.worktreeBaseRepo = info.baseRepo;
        if (pmoResolution && pmoBaseBranch) {
          metadataUpdates.pmoProjectId = pmoResolution.projectId;
          metadataUpdates.pmoBranch = pmoResolution.branch;
        }
      }
      workspaceRoot = info.worktreePath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] Worktree creation failed for ${wu.id}: ${message}`, { traceId });
      // 首 step 失败：会话未建立，重置避免下步 --resume 空 id
      if (newSessionId) await resetUnestablishedSession(deps.instance, deps.fileStore, metadataUpdates);
      return {
        workspaceRoot,
        earlyResult: {
          action: 'failed' as const,
          summary: `worktree 创建失败: ${message.slice(0, 500)}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'worktree_creation_failed',
            errorDetail: message.slice(0, 500),
            errorAt: new Date().toISOString(),
          },
        },
      };
    }
  } else if (wu.type === 'review') {
    // B3b-i: review WU 继承父 WU worktree（评审能看到 diff）；父无 worktree → 维持现状
    const parentWorktree = await resolveParentWorktreePath(deps.workUnitService, wu);
    if (parentWorktree) workspaceRoot = parentWorktree;
  }
  return { workspaceRoot };
}
