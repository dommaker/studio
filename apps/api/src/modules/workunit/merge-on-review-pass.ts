/**
 * B3b-ii 评审通过后自动合并（决策 D1/D3 后半）
 *
 * reviewPassed 收口触发（代码 WU 先保持 in_review，merge 与目标验证接受后才 done）：
 *   WU metadata 有 worktreeBranch + worktreeBaseRepo + worktreeBaseBranch 时，
 *   把 task/<wuId> 分支合并回目标分支（git --no-ff）。
 *
 * PMO-b（决策 3，2026-07-28 分析文档 §4.5）：metadata.pmoBranch 落档的 WU，
 *   目标 = PMO 腿分支——在按 project+repo+leg 键控的集成交合 worktree 上执行
 *   （不动 baseRepo 当前 checkout；冲突集中在单一合并点；分支名 = PMO id）。
 *   projectId 合并时经 resolvePmoProjectIdForWU 重解析（2026-08 归因统一：不再读
 *   metadata.pmoProjectId 缓存）；解析不出 → 转人工，不静默回落错误目标。
 *   未落档 → 维持现状：合 baseRepo 当前分支（git -C baseRepo merge）。
 *
 * 流程：
 *   0. 数据防丢闸：worktree 有未提交改动（或 git status 失败）→ 不合并不强删，
 *      WU 置 blocked + 频道列清单转人工（worktree/分支保留）
 *   1. git merge --no-ff task/<wuId>（baseRepo 或 PMO 集成交合）
 *   2. 失败 → abort 首次 merge 现场，重试一次：先在 worktree 把 task 分支 rebase 到
 *      baseBranch，成功则回合并目标再 merge
 *   3. 仍失败 → **保留冲突现场**（不再先 abort），spawn 一次性 LLM 会话解冲突
 *      （复用 system-executor，skill = resolving-merge-conflicts；prompt 带 mergeContext
 *      + verify 命令来源说明）；LLM 失败/超时/解完仍有残留冲突 → 回退现有 abort +
 *      blockForMergeFailure 转人工（兜底不变）。审计落 metadata.mergeResolution
 *   4. 合并成功（含 LLM 解完）→ 先落真实 mergeReceipt/HEAD，再在合并目标目录重跑 verify；
 *      红 → blocked 且保留 merged/commit 事实（不标 mergeConflict、不删 worktree/分支）；
 *      无命令 → verification=unavailable，仅人工 L3 可接受，不伪装自动通过
 *   5. passed 或 unavailable+L3 → done/completedAt 后移除 worktree、删除已合并 task 分支，
 *      频道发一条简短系统消息；其余情况保留现场
 *
 * 防重与恢复（#704）：同腿锁内重读 WU；mergedAt 仅作 Git 事实，not-run/passed 按阶段续跑，
 * 崩溃后先核查 source ancestry，receipt 只接受锁内真实 HEAD，避免重复 merge 与假回执。
 * 无 worktree 落档的 WU 直接旁路，行为与改造前完全一致。
 * #157（T6）：analysis 按类型硬旁路——原型单虽有 worktree 落档，但 prototype/<wuId>
 * 分支永不合并；其 reviewPassed 收尾（删 worktree 目录、留分支）见
 * cleanupPrototypeWorktreeOnReviewPass。
 *
 * 依赖说明（ARCH-02）：验证、PMO 归因与解冲突执行经 workunit-ports；
 * 不 import agent-loop/agents/requirements，频道系统消息走 wu-messenger 统一出口。
 */
import fs from 'node:fs';
import { LockTimeoutError, type FileStore } from '@dommaker/studio-shared';
import { isValidGitBranch } from '@dommaker/studio-contract';
import { logger } from '@dommaker/studio-shared/node';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { execFileAsync } from '../../core/exec-async.js';
import { withDeliveryLegLock } from '../../core/delivery-leg-lock.js';
import { ensurePmoIntegrationWorktree } from '@dommaker/studio-agent';
import type { WorkUnitReview } from './workunit-review.js';
import type { WorkUnitQuery } from './workunit-query.js';
import { hasUnsettledMergeEffect, type WorkUnitMetadata, type WorkUnitMergeIntent, type WorkUnitMergeReceipt } from './workunit.types.js';
import { snapshotToData, type WorkUnitData, type WorkUnitRepository } from './workunit-crud.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { parseWuMetadata } from './wu-metadata.js';
import { assertMandateAllows } from './mandate.js';
import { workUnitPort } from './workunit-ports.js';
import { getErrorMessage } from '../../utils/errors.js';
import { withExecutionRepo } from '../../utils/execution-repo-policy.js';

export type WorkUnitReviewMergePort = Pick<WorkUnitReview, 'blockForMergeFailure' | 'recordMergeProgress' | 'settleMerge'>
  & Pick<WorkUnitQuery, 'getById'>
  & Pick<WorkUnitRepository, 'update'>;

/** worktrees 根目录（与 agent-loop.resolveWorktreesDir 同口径：WORKTREES_DIR > studioPath('worktrees')，契约 §8 双口径收编） */
function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || studioPath('worktrees');
}

/** git 操作超时：merge 60s / rebase 120s / 其余轻量命令 15s */
const MERGE_TIMEOUT_MS = 60_000;
const REBASE_TIMEOUT_MS = 120_000;
const GIT_OP_TIMEOUT_MS = 15_000;

export type MergeOnReviewPassOutcome =
  | { attempted: false; reason: 'no-worktree' | 'already-merged' | 'analysis-bypass' | 'lock-busy' | 'mandate-rejected' }
  | { attempted: true; merged: true; mergeCommit: string }
  | { attempted: true; merged: false; conflictFiles: string[]; reason?: 'conflict' | 'uncommitted-changes' | 'merge-verify-failed' };

/** 冲突现场（保留给 LLM 解，不再先 abort）：merge = 合并目标目录；rebase = worktree */
interface ConflictScene {
  cwd: string;
  state: 'merge' | 'rebase';
}

/** LLM 解冲突审计（落 metadata.mergeResolution；类型正本在 workunit.types.ts） */
export type MergeResolutionAudit = NonNullable<WorkUnitMetadata['mergeResolution']>;

/** LLM 输出摘要截断（mergeResolution.summary） */
const MERGE_LLM_SUMMARY_CHARS = 500;

/** worktree 是否有未提交改动（git 失败按 dirty 处理——宁可转人工也不丢数据） */
async function listDirtyFiles(worktreePath: string, cwd: string): Promise<string[] | null> {
  try {
    const stdout = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      cwd, timeout: GIT_OP_TIMEOUT_MS,
    });
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** 取冲突文件清单（merge/rebase 冲突现场，diff-filter=U；失败返回 []） */
async function listConflictFiles(dir: string, cwd: string): Promise<string[]> {
  try {
    const stdout = await execFileAsync('git', ['-C', dir, 'diff', '--name-only', '--diff-filter=U'], {
      cwd, timeout: GIT_OP_TIMEOUT_MS,
    });
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** best-effort 清理 merge/rebase 现场（无现场时命令失败，吞掉） */
async function abortMergeAndRebase(baseRepo: string, worktreePath?: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', baseRepo, 'merge', '--abort'], {
      cwd: baseRepo, timeout: GIT_OP_TIMEOUT_MS,
    });
  } catch { /* best-effort */ }
  if (worktreePath) {
    try {
      await execFileAsync('git', ['-C', worktreePath, 'rebase', '--abort'], {
        cwd: baseRepo, timeout: GIT_OP_TIMEOUT_MS,
      });
    } catch { /* best-effort */ }
  }
}

/** 同腿锁内幂等清理；mergeCleanedAt 防止启动/周期恢复反复删除与播报。 */
async function cleanupMergedWorktree(
  wuService: WorkUnitReviewMergePort,
  wuId: string,
  baseRepo: string,
  worktreePath: string | undefined,
  branch: string,
): Promise<void> {
  let cleaned = true;
  if (worktreePath) {
    try {
      await execFileAsync('git', ['-C', baseRepo, 'worktree', 'remove', '--force', '--', worktreePath], {
        cwd: baseRepo, timeout: GIT_OP_TIMEOUT_MS,
      });
    } catch (err) {
      if (fs.existsSync(worktreePath)) cleaned = false;
      logger.warn('[MergeOnReviewPass] worktree remove failed (non-blocking)', { wuId, worktreePath, error: String(err) });
    }
  }
  try {
    await execFileAsync('git', ['-C', baseRepo, 'branch', '-d', '--', branch], {
      cwd: baseRepo, timeout: GIT_OP_TIMEOUT_MS,
    });
  } catch (err) {
    try {
      await execFileAsync('git', ['-C', baseRepo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: baseRepo, timeout: GIT_OP_TIMEOUT_MS,
      });
      cleaned = false;
    } catch { /* 分支已不存在，清理目标已达成 */ }
    logger.warn('[MergeOnReviewPass] branch delete failed (non-blocking)', { wuId, branch, error: String(err) });
  }
  if (!cleaned) return;
  const fresh = await wuService.getById(wuId);
  await wuService.update(wuId, {
    metadata: { ...parseWuMetadata(fresh?.metadata), mergeCleanedAt: new Date().toISOString() },
  });
}

/** 向 WU 所在频道发 Studio 系统消息（经 wu-messenger 统一出口：eventBus + SSE）。
 *  meta 由里程碑消息携带（2026-07 PMO-flow UX §6-3/§10：转人工 + 合并成功均带 pmoId?/atHuman）。 */
async function postSystemMessage(
  fileStore: FileStore,
  wu: WorkUnitData,
  content: string,
): Promise<void> {
  await postWuSystemMessage(wu, content, { milestone: true, fileStore });
}

/** 崩溃后从真实 Git 历史定位本 WU 的 merge commit；不能把后续 WU 的 HEAD 冒充本单回执。 */
async function findMergeCommitFromHistory(mergeCwd: string, wuId: string, sourceBranch: string): Promise<string | null> {
  const sourceOutput = await execFileAsync('git', ['-C', mergeCwd, 'rev-parse', sourceBranch], {
    cwd: mergeCwd, timeout: GIT_OP_TIMEOUT_MS,
  });
  const sourceCommit = sourceOutput.trim();
  const log = await execFileAsync('git', [
    '-C', mergeCwd, 'log', '--merges', '--format=%H%x20%P%x20%s', '--ancestry-path', `${sourceCommit}..HEAD`,
  ], { cwd: mergeCwd, timeout: GIT_OP_TIMEOUT_MS });
  const matches = log.split('\n').filter(line => {
    const [commit, ...rest] = line.trim().split(/\s+/);
    const subject = rest.join(' ');
    return Boolean(commit) && subject.includes(`merge: ${wuId} `) && rest.includes(sourceCommit);
  });
  return matches.length === 1 ? matches[0].trim().split(/\s+/, 1)[0] : null;
}

async function rejectMergeForMandate(
  wuService: WorkUnitReviewMergePort,
  wu: WorkUnitData,
  error: unknown,
): Promise<MergeOnReviewPassOutcome> {
  if (wu.status !== 'done' && wu.status !== 'closed') {
    await wuService.blockForMergeFailure(wu.id, [], { blockReason: `mandate: ${getErrorMessage(error)}` });
  }
  logger.warn('[MergeOnReviewPass] Mandate rejected before Git effect', { wuId: wu.id, error: String(error) });
  return { attempted: false, reason: 'mandate-rejected' };
}

/**
 * 评审通过后的自动合并入口。best-effort：内部错误均转 outcome/日志，不向调用方抛错；
 * 评审证据不回滚，代码 WU 在 receipt 接受前始终保持 in_review。
 */
export async function mergeWorktreeBranchOnReviewPass(
  wuService: WorkUnitReviewMergePort,
  wu: WorkUnitData,
  fileStore: FileStore,
  options: { recovery?: boolean } = {},
): Promise<MergeOnReviewPassOutcome> {
  let meta = parseWuMetadata(wu.metadata);
  const branch = meta.worktreeBranch;
  const configuredBaseRepo = meta.worktreeBaseRepo;
  const baseBranch = meta.worktreeBaseBranch;
  const worktreePath = meta.worktreePath;

  // #157（T6）：analysis 按类型硬旁路（类型硬编码，不再只看 metadata 三字段）——
  // 原型单有 worktree 落档，但 prototype/<wuId> 分支永不合并；
  // 收尾清理走 cleanupPrototypeWorktreeOnReviewPass。
  if (wu.type === 'analysis') {
    return { attempted: false, reason: 'analysis-bypass' };
  }
  // 旁路：无 worktree 落档（普通 analysis 等非代码类 WU）→ 无需合并；补一条完成里程碑出声
  if (!branch || !configuredBaseRepo || !baseBranch) {
    await postSystemMessage(
      fileStore,
      wu,
      `任务「${String(meta.title ?? wu.scope ?? '').slice(0, 50)}」评审通过，任务完成`,
    ).catch(err => logger.warn('[MergeOnReviewPass] post review-passed message failed', { wuId: wu.id, error: String(err) }));
    return { attempted: false, reason: 'no-worktree' };
  }
  try {
    assertMandateAllows(wu, 'merge', { repo: configuredBaseRepo, leg: meta.pmoBranch ?? baseBranch });
  } catch (error) {
    return rejectMergeForMandate(wuService, wu, error);
  }
  // mergedAt 只证明 Git 曾落点，不证明 verify/settle 已完成；恢复按 receipt 阶段续跑。
  const verification = meta.mergeReceipt?.verification.status;
  const resumeVerification = wu.status === 'in_review' && meta.mergeReceipt?.merged === true
    && (verification === 'not-run' || verification === 'passed');
  const recoverCleanup = options.recovery && wu.status === 'done' && meta.mergeReceipt?.merged === true && !meta.mergeCleanedAt;
  if (meta.mergedAt && !resumeVerification && !recoverCleanup) {
    return { attempted: false, reason: 'already-merged' };
  }

  const now = new Date().toISOString();
  const intent: WorkUnitMergeIntent = {
    id: meta.mergeIntent?.id ?? `merge:${wu.id}`,
    state: 'running',
    requestedAt: meta.mergeIntent?.requestedAt ?? now,
    startedAt: now,
    sourceBranch: branch,
    targetBranch: meta.pmoBranch ?? baseBranch,
  };
  await wuService.recordMergeProgress(wu.id, intent);

  // 存量 metadata 纵深防线：在任何 status/rev-parse/merge 子进程之前拒绝危险 ref。
  if (!isValidGitBranch(branch) || !isValidGitBranch(baseBranch)
    || (meta.pmoBranch !== undefined && !isValidGitBranch(meta.pmoBranch))) {
    await wuService.blockForMergeFailure(wu.id, []);
    logger.warn('[MergeOnReviewPass] invalid git branch rejected before spawn', {
      wuId: wu.id, branch, baseBranch, pmoBranch: meta.pmoBranch,
    });
    return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
  }

  try {
  return await withExecutionRepo(configuredBaseRepo, async baseRepo => withDeliveryLegLock({
    fileStore,
    repo: baseRepo,
    branch: meta.pmoBranch ?? baseBranch,
  }, async () => {
  // 等待腿锁期间另一个进程可能已完成同一 WU；必须以锁内最新快照为准。
  const fresh = await wuService.getById(wu.id);
  if (!fresh) return { attempted: false, reason: 'already-merged' };
  const freshMeta = parseWuMetadata(fresh.metadata);
  const freshTarget = {
    repo: freshMeta.worktreeBaseRepo ?? '',
    leg: freshMeta.pmoBranch ?? freshMeta.worktreeBaseBranch ?? null,
  };
  try {
    // 锁身份、授权范围和实际目标必须来自同一 fresh 快照；变化需回到新腿重新授权/排队。
    if (freshTarget.repo !== configuredBaseRepo || freshTarget.leg !== (meta.pmoBranch ?? baseBranch)) {
      throw new Error('Mandate target changed while acquiring delivery-leg lock');
    }
    assertMandateAllows(fresh, 'merge', freshTarget);
  } catch (error) {
    return rejectMergeForMandate(wuService, fresh, error);
  }
  if (fresh.status === 'done') {
    if (recoverCleanup) await cleanupMergedWorktree(wuService, wu.id, baseRepo, worktreePath, branch);
    return { attempted: false, reason: 'already-merged' };
  }
  if (fresh.status !== 'in_review') return { attempted: false, reason: 'already-merged' };
  const freshVerification = freshMeta.mergeReceipt?.verification.status;
  if (freshMeta.mergeReceipt?.merged === true && (freshVerification === 'unavailable' || freshVerification === 'failed')) {
    return { attempted: false, reason: 'already-merged' };
  }
  wu = fresh;
  meta = freshMeta;

  const title = String(meta.title ?? wu.scope ?? '').slice(0, 50);
  const scopeSummary = (wu.scope ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);

  // 数据防丢闸：worktree 有未提交改动时绝不合并/强删（下方清理是
  // `git worktree remove --force`，会静默丢弃未提交工作——e2e 实测发生过一次：
  // dev 改了未提交、合并 "Already up to date" 假成功、--force 删除丢弃改动）。
  // 转人工：WU 置 blocked + 频道列改动清单，worktree 与分支保留。
  if (worktreePath) {
    const dirtyFiles = await listDirtyFiles(worktreePath, baseRepo);
    if (dirtyFiles === null || dirtyFiles.length > 0) {
      await wuService.blockForMergeFailure(wu.id, dirtyFiles ?? []);
      const fileList = dirtyFiles?.length
        ? `\n未提交文件：\n${dirtyFiles.map(f => `- ${f}`).join('\n')}`
        : '（git status 调用失败，按有改动处理）';
      await postSystemMessage(
        fileStore,
        wu,
        `任务「${title}」的 worktree 仍有未提交改动，未执行自动合并，已转人工处理${fileList}`,
      ).catch(err => logger.warn('[MergeOnReviewPass] post dirty message failed', { wuId: wu.id, error: String(err) }));
      logger.warn('[MergeOnReviewPass] dirty worktree escalated to human (merge skipped)', {
        wuId: wu.id, branch, worktreePath, dirtyCount: dirtyFiles?.length ?? -1,
      });
      return { attempted: true, merged: false, conflictFiles: dirtyFiles ?? [], reason: 'uncommitted-changes' };
    }
  }

  // PMO-b（决策 3）：落档 pmoBranch 的 WU 合到 PMO 分支的集成交合 worktree
  // （不动 baseRepo 当前 checkout；冲突集中在单一合并点）。无落档 → 现状（合 baseRepo 当前分支）。
  // 2026-08 归因统一：agent-loop 不再随 pmoBranch 缓存落档 pmoProjectId；
  // ARCH-02 起经 project-read 端口从创建期戳（metadata.pmoId / reqId）重解析。
  let pmoProjectId: string | null = null;
  if (meta.pmoBranch) {
    try {
      pmoProjectId = await (await workUnitPort('projectRead')).resolvePmoId(
        { reqId: wu.reqId ?? null, metadata: wu.metadata },
        fileStore,
      ).catch(() => null); // best-effort：解析失败按无归属处理（下方转人工）
    } catch {
      pmoProjectId = null;
    }
  }

  let mergeContext: { args: string[]; cwd: string; targetBranch: string };
  if (meta.pmoBranch && !pmoProjectId) {
    // pmoBranch 落档但归属项目解析不出（项目被删等）→ 转人工，不静默回落错误目标
    await wuService.blockForMergeFailure(wu.id, []);
    await postSystemMessage(
      fileStore,
      wu,
      `任务「${title}」的 PMO 集成分支 ${meta.pmoBranch} 归属项目解析失败，已转人工处理`,
    ).catch(e => logger.warn('[MergeOnReviewPass] post pmo-resolve message failed', { wuId: wu.id, error: String(e) }));
    logger.warn('[MergeOnReviewPass] pmo attribution resolve failed', { wuId: wu.id, pmoBranch: meta.pmoBranch });
    return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
  }
  if (meta.pmoBranch && pmoProjectId) {
    let integration: { worktreePath: string };
    try {
      integration = await ensurePmoIntegrationWorktree({
        repoDir: baseRepo,
        worktreesDir: resolveWorktreesDir(),
        projectId: pmoProjectId,
        branch: meta.pmoBranch,
        baseBranch,
      });
    } catch (err) {
      // 集成交合建不起来（如 PMO 分支被意外检出）→ 转人工，不静默回落错目标
      const message = getErrorMessage(err);
      await wuService.blockForMergeFailure(wu.id, []);
      await postSystemMessage(
        fileStore,
        wu,
        `任务「${title}」的 PMO 集成分支 ${meta.pmoBranch} 准备失败（${message.slice(0, 200)}），已转人工处理`,
      ).catch(e => logger.warn('[MergeOnReviewPass] post pmo-setup message failed', { wuId: wu.id, error: String(e) }));
      logger.warn('[MergeOnReviewPass] pmo integration worktree setup failed', { wuId: wu.id, pmoBranch: meta.pmoBranch, error: message });
      return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
    }
    mergeContext = {
      args: ['-C', integration.worktreePath, 'merge', '--no-ff', '-m', `merge: ${wu.id} ${scopeSummary}`, '--', branch],
      cwd: integration.worktreePath,
      targetBranch: meta.pmoBranch,
    };
  } else {
    // #701：普通合并直接落在主 checkout，必须先证明它仍是创建 WU worktree 时记录的 base。
    let currentBranch: string | null = null;
    try {
      const stdout = await execFileAsync('git', ['-C', baseRepo, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: baseRepo, timeout: GIT_OP_TIMEOUT_MS,
      });
      currentBranch = stdout.trim();
    } catch { /* 探测失败同样 fail-closed */ }
    if (currentBranch !== baseBranch) {
      await wuService.blockForMergeFailure(wu.id, []);
      await postSystemMessage(
        fileStore,
        wu,
        `任务「${title}」的合并目标已变化：记录 baseBranch=${baseBranch}，当前 checkout=${currentBranch || '未知'}，未执行自动合并，已转人工处理`,
      ).catch(e => logger.warn('[MergeOnReviewPass] post base-mismatch message failed', { wuId: wu.id, error: String(e) }));
      logger.warn('[MergeOnReviewPass] base branch mismatch (merge skipped)', { wuId: wu.id, baseBranch, currentBranch });
      return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
    }
    mergeContext = {
      args: ['-C', baseRepo, 'merge', '--no-ff', '-m', `merge: ${wu.id} ${scopeSummary}`, '--', branch],
      cwd: baseRepo,
      targetBranch: baseBranch,
    };
  }

  let baseReceipt = meta.mergeReceipt?.merged === true && meta.mergeReceipt.mergeCommit
    ? meta.mergeReceipt
    : null;
  let mergeCommit = baseReceipt?.mergeCommit ?? '';
  if (!baseReceipt) {
    let sourceAlreadyMerged = false;
    if (options.recovery) {
      try {
        await execFileAsync('git', ['-C', mergeContext.cwd, 'merge-base', '--is-ancestor', branch, 'HEAD'], {
          cwd: mergeContext.cwd, timeout: GIT_OP_TIMEOUT_MS,
        });
        sourceAlreadyMerged = true;
      } catch { /* 未合并则走正常 merge */ }
    }

    if (!sourceAlreadyMerged) {
      const merged = await tryMergeWithRebaseRetry(mergeContext.args, mergeContext.cwd, mergeContext.targetBranch, branch, worktreePath);
      // 注：本包 tsconfig 未开 strict，真值判断不收窄可辨识联合，须用 === false 字面量比较
      if (merged.ok === false) {
        const { audit, resolved } = await resolveConflictSceneWithLlm({
          wu,
          meta,
          scene: merged.scene,
          conflictFiles: merged.conflictFiles,
          mergeArgs: mergeContext.args,
          mergeCwd: mergeContext.cwd,
          sourceBranch: branch,
          targetBranch: mergeContext.targetBranch,
          scopeSummary,
        });
        await recordMergeResolution(wuService, wu.id, audit);
        if (!resolved) {
          await abortMergeAndRebase(mergeContext.cwd, merged.scene.state === 'rebase' ? worktreePath : undefined);
          await wuService.blockForMergeFailure(wu.id, merged.conflictFiles);
          const fileList = merged.conflictFiles.length > 0
            ? `\n冲突文件：\n${merged.conflictFiles.map(f => `- ${f}`).join('\n')}`
            : '（未能获取冲突文件清单）';
          await postSystemMessage(
            fileStore,
            wu,
            `任务「${title}」自动合并到 ${mergeContext.targetBranch} 失败（重试后仍冲突），已转人工处理${fileList}`,
          ).catch(err => logger.warn('[MergeOnReviewPass] post conflict message failed', { wuId: wu.id, error: String(err) }));
          logger.warn('[MergeOnReviewPass] merge conflict escalated to human (LLM resolution failed)', {
            wuId: wu.id, branch, targetBranch: mergeContext.targetBranch, conflictFiles: merged.conflictFiles,
            llmError: audit.error,
          });
          return { attempted: true, merged: false, conflictFiles: merged.conflictFiles };
        }
        logger.info('[MergeOnReviewPass] conflict resolved by LLM', {
          wuId: wu.id, state: merged.scene.state, durationMs: audit.durationMs,
        });
      }
    }

    // 本次 merge 可读锁内 HEAD；恢复已发生 merge 必须从历史定位本 WU 的真实 merge commit。
    try {
      if (sourceAlreadyMerged) {
        mergeCommit = await findMergeCommitFromHistory(mergeContext.cwd, wu.id, branch) ?? '';
      } else {
        const stdout = await execFileAsync('git', ['-C', mergeContext.cwd, 'rev-parse', 'HEAD'], {
          cwd: mergeContext.cwd, timeout: GIT_OP_TIMEOUT_MS,
        });
        mergeCommit = stdout.trim();
      }
    } catch (err) {
      logger.warn('[MergeOnReviewPass] resolve merge commit failed', { wuId: wu.id, error: String(err) });
    }
    baseReceipt = {
      id: intent.id,
      merged: true,
      mergedAt: new Date().toISOString(),
      ...(mergeCommit ? { mergeCommit } : {}),
      targetBranch: mergeContext.targetBranch,
      verification: { status: 'not-run', ran: [] },
    };
    if (!mergeCommit) {
      await wuService.settleMerge(wu.id, {
        receipt: { ...baseReceipt, failure: { kind: 'merge-error', detail: 'resolve merge commit failed' } },
        outcome: 'blocked',
        blockReason: 'merge-receipt-failed: 无法确定本任务的真实 merge commit',
      });
      return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
    }
    await wuService.settleMerge(wu.id, { receipt: baseReceipt, outcome: 'in_review' });
  }

  if (options.recovery) {
    try {
      await execFileAsync('git', ['-C', mergeContext.cwd, 'merge-base', '--is-ancestor', branch, mergeCommit], {
        cwd: mergeContext.cwd, timeout: GIT_OP_TIMEOUT_MS,
      });
      await execFileAsync('git', ['-C', mergeContext.cwd, 'merge-base', '--is-ancestor', mergeCommit, 'HEAD'], {
        cwd: mergeContext.cwd, timeout: GIT_OP_TIMEOUT_MS,
      });
      await execFileAsync('git', ['-C', mergeContext.cwd, 'merge-base', '--is-ancestor', branch, 'HEAD'], {
        cwd: mergeContext.cwd, timeout: GIT_OP_TIMEOUT_MS,
      });
    } catch {
      await wuService.settleMerge(wu.id, {
        receipt: { ...baseReceipt, failure: { kind: 'merge-error', detail: 'merge receipt diverged from target HEAD' } },
        outcome: 'blocked',
        blockReason: 'merge-receipt-failed: 回执与当前目标历史不一致',
      });
      return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
    }
  }

  let receipt = baseReceipt;
  if (receipt.verification.status !== 'passed') {
    const verify = await runMergeVerification(wu, meta, mergeContext.cwd);
    const verification: WorkUnitMergeReceipt['verification'] = verify.failure
      ? { status: 'failed', ran: verify.ran, failure: verify.failure }
      : verify.ran.length === 0
        ? { status: 'unavailable', ran: [] }
        : { status: 'passed', ran: verify.ran };
    receipt = { ...baseReceipt, verification };
    if (verify.failure) {
      await wuService.settleMerge(wu.id, {
        receipt: { ...receipt, failure: { kind: 'verification', detail: verify.failure.command } },
        outcome: 'blocked',
        blockReason: `merge-verify-failed: 合并后验证失败（${verify.failure.command}）`.slice(0, 300),
      });
      await postSystemMessage(
        fileStore,
        wu,
        `任务「${title}」已合并到 ${mergeContext.targetBranch}，但合并后验证失败（${verify.failure.command}），已转人工处理\n失败输出尾部：\n${verify.failure.tail.slice(0, 1000)}`,
      ).catch(err => logger.warn('[MergeOnReviewPass] post verify-failed message failed', { wuId: wu.id, error: String(err) }));
      logger.warn('[MergeOnReviewPass] post-merge verification failed, escalated to human', {
        wuId: wu.id, branch, targetBranch: mergeContext.targetBranch,
        failedCommand: verify.failure.command, ran: verify.ran,
      });
      return { attempted: true, merged: false, conflictFiles: [], reason: 'merge-verify-failed' };
    }
  }

  const settled = await wuService.settleMerge(wu.id, { receipt, outcome: 'done' });
  if (settled.status === 'done') {
    await cleanupMergedWorktree(wuService, wu.id, baseRepo, worktreePath, branch);

    await postSystemMessage(
      fileStore,
      wu,
      `任务「${title}」已合并到 ${mergeContext.targetBranch}（merge commit ${mergeCommit.slice(0, 7)}）`,
    ).catch(err => logger.warn('[MergeOnReviewPass] post merged message failed', { wuId: wu.id, error: String(err) }));
  }
  logger.info('[MergeOnReviewPass] branch merged', { wuId: wu.id, branch, targetBranch: mergeContext.targetBranch, mergeCommit, verification: receipt.verification.status });
  return { attempted: true, merged: true, mergeCommit };
  }));
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      logger.warn('[MergeOnReviewPass] delivery leg lock busy; merge left queued for recovery', { wuId: wu.id, branch });
      return { attempted: false, reason: 'lock-busy' };
    }
    throw err;
  }
}

/**
 * merge 一次；失败则 abort 首次现场后在 worktree rebase 到 baseBranch，再 merge 一次。
 * 终态失败**保留冲突现场**（不 abort）交 LLM 解——scene 指明现场目录与 merge/rebase 状态；
 * 兜底清理由调用方在 LLM 解失败后做（abortMergeAndRebase）。
 */
async function tryMergeWithRebaseRetry(
  mergeArgs: string[],
  mergeCwd: string,
  baseBranch: string,
  branch: string,
  worktreePath?: string,
): Promise<{ ok: true } | { ok: false; conflictFiles: string[]; scene: ConflictScene }> {
  try {
    await execFileAsync('git', mergeArgs, { cwd: mergeCwd, timeout: MERGE_TIMEOUT_MS });
    return { ok: true };
  } catch { /* 进入重试 */ }

  // 无 worktree 无法 rebase：保留 merge 冲突现场（合并目标目录）交 LLM 解
  if (!worktreePath) {
    const conflictFiles = await listConflictFiles(mergeCwd, mergeCwd);
    return { ok: false, conflictFiles, scene: { cwd: mergeCwd, state: 'merge' } };
  }

  // 清理首次 merge 现场（rebase 重试的前提；终态失败现场在下方保留）
  await abortMergeAndRebase(mergeCwd);
  try {
    await execFileAsync('git', ['-C', worktreePath, 'rebase', '--', baseBranch], {
      cwd: mergeCwd, timeout: REBASE_TIMEOUT_MS,
    });
  } catch {
    // rebase 冲突：取清单后保留现场（worktree）交 LLM 解，不再 abort
    const conflictFiles = await listConflictFiles(worktreePath, mergeCwd);
    logger.warn('[MergeOnReviewPass] rebase onto base failed (scene kept for LLM)', { branch, baseBranch, conflictFiles });
    return { ok: false, conflictFiles, scene: { cwd: worktreePath, state: 'rebase' } };
  }

  try {
    await execFileAsync('git', mergeArgs, { cwd: mergeCwd, timeout: MERGE_TIMEOUT_MS });
    return { ok: true };
  } catch {
    // 二次 merge 冲突：取清单后保留现场（合并目标目录）交 LLM 解，不再 abort
    const conflictFiles = await listConflictFiles(mergeCwd, mergeCwd);
    logger.warn('[MergeOnReviewPass] merge after rebase still failed (scene kept for LLM)', { branch, baseBranch, conflictFiles });
    return { ok: false, conflictFiles, scene: { cwd: mergeCwd, state: 'merge' } };
  }
}

/**
 * 冲突现场交 LLM 解（对齐 resolving-merge-conflicts skill：保留双方意图、永不 --abort、
 * 解完跑项目验证命令全绿才算完成）。spawn 复用蒸馏管线同款 system-executor 一次性会话
 * （skill 全文作 systemPrompt，mergeContext + verify 命令来源作 prompt，cwd = 冲突现场）。
 * 确定性校验收尾（不信 LLM 自报）：冲突标记清零 + 源分支确为目标 HEAD 祖先才算解完；
 * rebase 现场解完后重放 merge。
 */
async function resolveConflictSceneWithLlm(args: {
  wu: WorkUnitData;
  meta: WorkUnitMetadata;
  scene: ConflictScene;
  conflictFiles: string[];
  mergeArgs: string[];
  mergeCwd: string;
  sourceBranch: string;
  targetBranch: string;
  scopeSummary: string;
}): Promise<{ audit: MergeResolutionAudit; resolved: boolean }> {
  const { wu, meta, scene, conflictFiles, mergeArgs, mergeCwd, sourceBranch, targetBranch, scopeSummary } = args;
  const startMs = Date.now();
  const base = {
    attemptedAt: new Date().toISOString(),
    state: scene.state,
    cwd: scene.cwd,
    conflictFiles,
  };
  const fail = (error: string): { audit: MergeResolutionAudit; resolved: false } => ({
    audit: { ...base, ok: false, durationMs: Date.now() - startMs, error },
    resolved: false,
  });

  // skill 全文作 systemPrompt（lazy import 同下方循环依赖规避口径）；拿不到不乱来——
  // 无流程卡约束 LLM 可能 --abort 毁现场，直接回退人工
  const { skillLoader } = await import('@dommaker/studio-skill');
  const skill = skillLoader.loadSingle('resolving-merge-conflicts');
  if (!skill?.prompt) return fail('skill resolving-merge-conflicts 不可用（未 seed？）');

  // verify 命令与解冲突执行均经 ARCH-02 端口，安全策略仍由 core/Agents 实现持有。
  const { commands: verifyCommands, source: verifySource } = await (await workUnitPort('verification')).resolveCommands(wu, meta, scene.cwd);

  let output: string;
  let durationMs: number;
  try {
    const result = await (await workUnitPort('execution')).run(
      buildMergeConflictPrompt({ scene, conflictFiles, sourceBranch, targetBranch, scopeSummary, verifyCommands, verifySource }),
      { systemPrompt: skill.prompt, cwd: scene.cwd, eventSource: 'merge-conflict-resolution' },
    );
    output = result.output;
    durationMs = result.durationMs;
  } catch (err) {
    return fail(`LLM 解冲突失败/超时: ${getErrorMessage(err).slice(0, 200)}`);
  }

  // 确定性校验：冲突标记清零才算解完（不信 LLM 自报）
  const remaining = await listConflictFiles(scene.cwd, scene.cwd);
  if (remaining.length > 0) {
    return fail(`LLM 解完仍有 ${remaining.length} 个冲突文件: ${remaining.join(', ').slice(0, 200)}`);
  }

  // rebase 现场：LLM 完成 rebase（--continue 直到落完）后重放 merge（rebase 后应为干净合并）
  if (scene.state === 'rebase') {
    try {
      await execFileAsync('git', mergeArgs, { cwd: mergeCwd, timeout: MERGE_TIMEOUT_MS });
    } catch (err) {
      return fail(`rebase 解完后重放 merge 仍失败: ${getErrorMessage(err).slice(0, 200)}`);
    }
  }

  // 无冲突文件 ≠ 已合并：源分支必须真实进入目标 HEAD，否则不能把当前 HEAD 写成 merge receipt。
  try {
    await execFileAsync('git', ['-C', mergeCwd, 'merge-base', '--is-ancestor', sourceBranch, 'HEAD'], {
      cwd: mergeCwd, timeout: GIT_OP_TIMEOUT_MS,
    });
  } catch (err) {
    return fail(`LLM 解完后源分支仍未进入目标 HEAD: ${getErrorMessage(err).slice(0, 200)}`);
  }

  return {
    audit: { ...base, ok: true, durationMs, summary: output.slice(-MERGE_LLM_SUMMARY_CHARS) },
    resolved: true,
  };
}

/** LLM 解冲突 prompt：mergeContext + verify 命令来源说明（skill 全文走 systemPrompt） */
function buildMergeConflictPrompt(args: {
  scene: ConflictScene;
  conflictFiles: string[];
  sourceBranch: string;
  targetBranch: string;
  scopeSummary: string;
  verifyCommands: string[];
  verifySource: 'override' | 'convention';
}): string {
  const { scene, conflictFiles, sourceBranch, targetBranch, scopeSummary, verifyCommands, verifySource } = args;
  return [
    '自动合并产生冲突，请按系统提示词中的流程在现场解冲突并完成合并。',
    '',
    '## mergeContext',
    `- cwd: ${scene.cwd}（冲突现场目录，在此工作）`,
    `- 现场状态: ${scene.state === 'merge' ? 'merge 进行中（git merge 冲突）' : 'rebase 进行中（git rebase 冲突，解完后 rebase --continue 直到全部 commit 落完）'}`,
    `- 目标分支: ${targetBranch}`,
    `- 来源分支: ${sourceBranch}`,
    `- 任务: ${scopeSummary}`,
    '- 冲突文件:',
    ...(conflictFiles.length > 0 ? conflictFiles.map(f => `  - ${f}`) : ['  （未能获取清单，用 git status 确认）']),
    '',
    '## 验证命令（解完后在 cwd 依次跑，全绿才算完成）',
    ...(verifyCommands.length > 0
      ? verifyCommands.map(c => `- ${c}`)
      : ['- （未能解析出验证命令；至少确认 git status 干净、无残留冲突标记）']),
    `命令来源: 服务端登记模板（${verifySource}；目录 package.json scripts 仅选择启用项）`,
  ].join('\n');
}

/** LLM 解冲突审计落 metadata.mergeResolution（仿 distill runs.jsonl 审计思路，落 WU metadata；best-effort） */
async function recordMergeResolution(
  wuService: WorkUnitReviewMergePort,
  wuId: string,
  audit: MergeResolutionAudit,
): Promise<void> {
  try {
    const fresh = await wuService.getById(wuId);
    const freshMeta = parseWuMetadata(fresh?.metadata);
    await wuService.update(wuId, { metadata: { ...freshMeta, mergeResolution: audit } });
  } catch (err) {
    logger.warn('[MergeOnReviewPass] record mergeResolution failed (non-blocking)', { wuId, error: String(err) });
  }
}

/** 合并后 verify：实现由 verification 端口注入，cwdProvenance 语义不变。 */
async function runMergeVerification(wu: WorkUnitData, meta: WorkUnitMetadata, mergeCwd: string) {
  return (await workUnitPort('verification')).run(wu, meta, mergeCwd, { cwdProvenance: 'merge-target' });
}

/** 启动/周期对账恢复：未 settle 的 merge effect 与 done 后未完成的幂等清理。 */
export async function recoverWorktreeMerges(
  wuService: WorkUnitReviewMergePort,
  fileStore: FileStore,
): Promise<{ attempted: number; failed: number }> {
  const snapshots = await fileStore.getIndex();
  const candidates = snapshots.filter(snapshot => {
    const metadata = parseWuMetadata(snapshot.metadata);
    if (!metadata.worktreeBranch || !metadata.worktreeBaseRepo || !metadata.worktreeBaseBranch) return false;
    if (snapshot.status === 'in_review') return hasUnsettledMergeEffect(snapshot.metadata);
    return snapshot.status === 'done' && metadata.mergeReceipt?.merged === true && !metadata.mergeCleanedAt;
  });

  let failed = 0;
  for (const snapshot of candidates) {
    try {
      await mergeWorktreeBranchOnReviewPass(wuService, snapshotToData(snapshot), fileStore, { recovery: true });
    } catch (err) {
      failed++;
      logger.warn('[MergeOnReviewPass] recovery failed; left for next reconciliation', { wuId: snapshot.id, error: String(err) });
    }
  }
  return { attempted: candidates.length, failed };
}

// ── #157（T6）：analysis 原型单 reviewPassed 收尾 ──

export type PrototypeWorktreeCleanupOutcome =
  | { attempted: false; reason: 'not-analysis-prototype' }
  | { attempted: true; removed: boolean };

/**
 * #157（T6）：analysis 原型单评审通过后的 worktree 收尾——删 worktree 目录、
 * 保留 prototype/<wuId> 分支（复用合并收尾的 worktree 清理，跳过合并与删分支；
 * 原型分支是一次性代码的证据存档，永不合并）。
 * 数据防丢（与合并闸同口径）：worktree 有未提交改动（或 git status 失败）→ 不删，
 * 目录与分支都保留交人工；不置 blocked、不改状态（done 迁移已完成，仅记日志）。
 * best-effort：任何失败只记日志，不向调用方抛错。
 */
export async function cleanupPrototypeWorktreeOnReviewPass(
  wu: WorkUnitData,
): Promise<PrototypeWorktreeCleanupOutcome> {
  if (wu.type !== 'analysis') return { attempted: false, reason: 'not-analysis-prototype' };
  const meta = parseWuMetadata(wu.metadata);
  const worktreePath = meta.worktreePath;
  const baseRepo = meta.worktreeBaseRepo;
  if (!worktreePath || !baseRepo) return { attempted: false, reason: 'not-analysis-prototype' };

  try {
    return await withExecutionRepo(baseRepo, async capabilityRepo => {
      const dirtyFiles = await listDirtyFiles(worktreePath, capabilityRepo);
      if (dirtyFiles === null || dirtyFiles.length > 0) {
        logger.warn('[MergeOnReviewPass] prototype worktree dirty at review-pass cleanup — kept for human', {
          wuId: wu.id, worktreePath, branch: meta.worktreeBranch, dirtyCount: dirtyFiles?.length ?? -1,
        });
        return { attempted: true as const, removed: false };
      }
      await execFileAsync('git', ['-C', capabilityRepo, 'worktree', 'remove', '--force', '--', worktreePath], {
        cwd: capabilityRepo, timeout: GIT_OP_TIMEOUT_MS,
      });
      logger.info('[MergeOnReviewPass] prototype worktree removed (branch kept)', {
        wuId: wu.id, worktreePath, branch: meta.worktreeBranch,
      });
      return { attempted: true as const, removed: true };
    });
  } catch (err) {
    logger.warn('[MergeOnReviewPass] prototype worktree remove failed (non-blocking)', {
      wuId: wu.id, worktreePath, error: String(err),
    });
    return { attempted: true, removed: false };
  }
}
