import { ensureWuWorktree, ensureBranchExists, getDefaultBranch } from '@dommaker/studio-agent';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { resolvePmoBranchForWU } from '../../requirements/index.js';
import { getErrorMessage } from '../../../utils/errors.js';
import { CODE_WORKTREE_TYPES } from '../wu-verification.js';
import { isGitRepoRoot, resolveWorktreesDir } from '../agent-loop-parsers.js';
import { resolveExecutionWorkspaceRoot, resolveParentWorktreePath } from '../execution-cwd.js';
import type { StepResult } from '../agent-loop.types.js';
import type { StepDeps } from './loop-deps.js';
import { logger } from '@dommaker/studio-shared/node';
import { withExecutionRepo } from '../../../utils/execution-repo-policy.js';

export interface StepWorktreeInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  metadataUpdates: Partial<WorkUnitMetadata>;
  traceId?: string;
}

export interface StepWorktreeResolution {
  workspaceRoot: string | null;
  failure?: StepResult;
}

/** F6 → B3a/B3b-i/PMO-b：解析本步执行根目录与 WU 专属 worktree。 */
export async function resolveStepWorktree(
  input: StepWorktreeInput,
  deps: StepDeps,
): Promise<StepWorktreeResolution> {
  const { wu, metadata, metadataUpdates, traceId } = input;
  // F6 → B3a: WorkUnit 绑定工程 → 解析执行根目录，经 parameters.workspaceRoot
  // 传给 agent-runner（resolveWorkspace Priority 1：直接以该目录为 cwd）。
  // #481：唯一来源是 metadata.workspaceRoot（B3a 归属链：Requirement→PMO gitRepo /
  // 文件引用 / 频道默认工程 / 人工回复绑定）；wu.workspaceId 不再参与 cwd 决策。
  // 都没有 → 不传，由 runner 落共享工作目录（REPO_DIR）或隔离 scratch。
  //
  // B3b-i（决策 D1）：代码类 WU（task/bug/feature/refactor）解析出 git 仓库根后，
  // 不再直接改共享目录 —— 执行 cwd 换成该仓库的专属 worktree
  // （<worktreesDir>/wu-<wuId>，分支 task/<wuId>）。同一 WU 跨 step 复用：
  // 首个 step 创建并把 worktreePath/branch/baseBranch/baseRepo 记入 metadata，
  // 后续 step 经 ensureWuWorktree 按目录存在性复用。创建失败走 B1 失败分支
  // （action='failed' → consecutiveStuck → 3 次 blocked），绝不静默退回共享目录。
  // 解析不出 git 仓库（无绑定根 / 根目录无 .git）→ 维持现状。
  // #157（T6）：analysis 原型单（建单显式 metadata.prototype=true）同样挂专属 worktree，
  // 分支前缀 prototype/（永不合并）；无标记的普通 analysis 行为逐字节不变。
  const cwdDeps = { getWuById: (wuId: string) => deps.workUnits.getById(wuId) };
  let workspaceRoot = resolveExecutionWorkspaceRoot(metadata);
  const wantsWuWorktree = CODE_WORKTREE_TYPES.has(wu.type)
    || (wu.type === 'analysis' && metadata.prototype === true);
  if (wantsWuWorktree && workspaceRoot && isGitRepoRoot(workspaceRoot)) {
    try {
      const configuredRepo = workspaceRoot;
      await withExecutionRepo(configuredRepo, async capabilityRepo => {
        // PMO-b（决策 3）：WU 归属 PMO → base 从默认分支改为 PMO 分支（分支名 = PMO id），
        // per-WU 临时分支从 PMO 分支拉、向 PMO 分支合（merge-on-review-pass 消费 pmoBranch 落档）。
        // 解析/建支失败回落默认 base，绝不阻断执行。
        let pmoBaseBranch: string | null = null;
        const pmoResolution = await resolvePmoBranchForWU(wu, deps.fileStore).catch(() => null);
        if (pmoResolution) {
          try {
            await ensureBranchExists({
              repoDir: capabilityRepo,
              branch: pmoResolution.branch,
              baseBranch: typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
                ? metadata.worktreeBaseBranch
                : getDefaultBranch(capabilityRepo),
            });
            pmoBaseBranch = pmoResolution.branch;
          } catch (err) {
            logger.warn(`[AgentLoop] PMO branch ensure failed, falling back to default base: ${getErrorMessage(err)}`, { traceId });
          }
        }
        const info = await ensureWuWorktree({
          wuId: wu.id,
          repoDir: capabilityRepo,
          worktreesDir: resolveWorktreesDir(),
          baseBranch: pmoBaseBranch
            ?? (typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
              ? metadata.worktreeBaseBranch
              : undefined),
          // #157（T6）：analysis 原型单分支 = prototype/<wuId>（永不合并）
          branchPrefix: wu.type === 'analysis' ? 'prototype' : undefined,
        });
        if (metadata.worktreePath !== info.worktreePath) {
          metadataUpdates.worktreePath = info.worktreePath;
          metadataUpdates.worktreeBranch = info.branch;
          metadataUpdates.worktreeBaseBranch = info.baseBranch;
          // capability 仅在本回调有效；持久化必须保留配置原路径。
          metadataUpdates.worktreeBaseRepo = configuredRepo;
          if (pmoResolution && pmoBaseBranch) {
            // 2026-08 归因统一：只落 pmoBranch（merge-on-review-pass 的合并目标）；
            // 项目 id 不再缓存落档（原 pmoProjectId 为冗余缓存），消费方经
            // resolvePmoProjectIdForWU 从创建期戳（metadata.pmoId / reqId）重解析
            metadataUpdates.pmoBranch = pmoResolution.branch;
          }
        }
        workspaceRoot = info.worktreePath;
      });
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error(`[AgentLoop] Worktree creation failed for ${wu.id}: ${message}`, { traceId });
      // 会话签发在 worktree 解析之后（#94），此处尚无会话簿记需重置
      return {
        workspaceRoot,
        failure: {
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
    const parentWorktree = await resolveParentWorktreePath(wu, cwdDeps);
    if (parentWorktree) workspaceRoot = parentWorktree;
  }

  return { workspaceRoot };
}
