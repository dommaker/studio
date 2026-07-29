/**
 * B3b-ii 评审通过后自动合并（决策 D1/D3 后半）
 *
 * reviewPassed 收口触发（best-effort，不阻断 done 状态迁移）：
 *   WU metadata 有 worktreeBranch + worktreeBaseRepo + worktreeBaseBranch 时，
 *   把 task/<wuId> 分支合并回目标分支（git --no-ff）。
 *
 * PMO-b（决策 3，2026-07-28 分析文档 §4.5）：metadata.pmoBranch 落档的 WU，
 *   目标 = PMO 分支——在 <worktreesDir>/pmo-<projectId> 集成交合 worktree 上执行
 *   （不动 baseRepo 当前 checkout；冲突集中在单一合并点；分支名 = PMO id）。
 *   未落档 → 维持现状：合 baseRepo 当前分支（git -C baseRepo merge）。
 *
 * 流程：
 *   0. 数据防丢闸：worktree 有未提交改动（或 git status 失败）→ 不合并不强删，
 *      WU 置 blocked + 频道列清单转人工（worktree/分支保留）
 *   1. git merge --no-ff task/<wuId>（baseRepo）
 *   2. 失败 → merge --abort，重试一次：先在 worktree 把 task 分支 rebase 到
 *      baseBranch，成功则回 baseRepo 再 merge
 *   3. 仍失败 → 清理 rebase/merge 现场，取冲突文件清单（diff-filter=U），
 *      频道发 Studio 系统消息转人工，WU 置 blocked（metadata.mergeConflict/conflictFiles）
 *   4. 成功 → 移除 worktree、删除已合并 task 分支、metadata 记 mergedAt/mergeCommit，
 *      频道发一条简短系统消息
 *
 * 防重：metadata.mergedAt 存在即跳过（人工重复触发 / 事件重放均不再合并）。
 * 无 worktree 落档的 WU（analysis 等）直接旁路，行为与改造前完全一致。
 *
 * 依赖说明：只依赖 studio-shared(+node) 与 WorkUnitService 类型，不 import
 * agent-loop（避免 workunit.service → 本模块 → agent-loop 的重依赖链与循环）；
 * anchor 查找内联实现（语义同 agent-loop.findAnchorMessage）。
 */
import { randomUUID } from 'crypto';
import { logger, type FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { ensurePmoIntegrationWorktree } from '@dommaker/studio-agent';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkUnitService, WorkUnitData, WorkUnitMetadata } from './workunit.service.js';

/** worktrees 根目录（与 agent-loop.resolveWorktreesDir 同口径：WORKTREES_DIR > ~/worktrees） */
function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
}

/** git 操作超时：merge 60s / rebase 120s / 其余轻量命令 15s */
const MERGE_TIMEOUT_MS = 60_000;
const REBASE_TIMEOUT_MS = 120_000;
const GIT_OP_TIMEOUT_MS = 15_000;

export type MergeOnReviewPassOutcome =
  | { attempted: false; reason: 'no-worktree' | 'already-merged' }
  | { attempted: true; merged: true; mergeCommit: string }
  | { attempted: true; merged: false; conflictFiles: string[]; reason?: 'conflict' | 'uncommitted-changes' };

/** shell 单引号转义（branch/路径/提交信息统一过它进 bash -c） */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** worktree 是否有未提交改动（git 失败按 dirty 处理——宁可转人工也不丢数据） */
async function listDirtyFiles(worktreePath: string, cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execSh(`git -C ${shq(worktreePath)} status --porcelain`, {
      cwd, timeoutMs: GIT_OP_TIMEOUT_MS,
    });
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** 取冲突文件清单（merge/rebase 冲突现场，diff-filter=U；失败返回 []） */
async function listConflictFiles(dir: string, cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execSh(
      `git -C ${shq(dir)} diff --name-only --diff-filter=U`,
      { cwd, timeoutMs: GIT_OP_TIMEOUT_MS },
    );
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** best-effort 清理 merge/rebase 现场（无现场时命令失败，吞掉） */
async function abortMergeAndRebase(baseRepo: string, worktreePath?: string): Promise<void> {
  try {
    await execSh(`git -C ${shq(baseRepo)} merge --abort 2>/dev/null || true`, {
      cwd: baseRepo, timeoutMs: GIT_OP_TIMEOUT_MS,
    });
  } catch { /* best-effort */ }
  if (worktreePath) {
    try {
      await execSh(`git -C ${shq(worktreePath)} rebase --abort 2>/dev/null || true`, {
        cwd: baseRepo, timeoutMs: GIT_OP_TIMEOUT_MS,
      });
    } catch { /* best-effort */ }
  }
}

/** anchor 查找（语义同 agent-loop.findAnchorMessage：该 WU 频道线程的首条根消息） */
async function findAnchor(workUnitId: string, fileStore: FileStore): Promise<ChannelMessageData | null> {
  const messages = await fileStore.queryAllMessages({ workUnitId });
  const anchors = messages
    .filter(m => !m.replyToId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return anchors[0] ?? null;
}

/** 向 WU 所在频道发 Studio 系统消息（形态参照 waiting-input.postStudioSystemMessage） */
async function postSystemMessage(
  fileStore: FileStore,
  wu: WorkUnitData,
  content: string,
): Promise<void> {
  if (!wu.channelId) return;
  const anchor = await findAnchor(wu.id, fileStore).catch(() => null);
  const msg: ChannelMessageData = {
    id: randomUUID(),
    channelId: wu.channelId,
    authorType: 'agent',
    agentName: 'Studio',
    content,
    replyToId: anchor?.id ?? null,
    meta: '{}',
    workUnitId: wu.id,
    createdAt: new Date().toISOString(),
  };
  await fileStore.appendMessage(wu.channelId, msg);
}

/**
 * 评审通过后的自动合并入口。best-effort：内部错误均转 outcome/日志，不向调用方抛错
 * （reviewPassed 的 done 迁移已完成，合并失败只影响后续流转，不回滚评审结论）。
 */
export async function mergeWorktreeBranchOnReviewPass(
  wuService: WorkUnitService,
  wu: WorkUnitData,
  fileStore: FileStore,
): Promise<MergeOnReviewPassOutcome> {
  const meta = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
  const branch = meta.worktreeBranch;
  const baseRepo = meta.worktreeBaseRepo;
  const baseBranch = meta.worktreeBaseBranch;
  const worktreePath = meta.worktreePath;

  // 旁路：无 worktree 落档（analysis 等非代码类 WU）→ 行为不变
  if (!branch || !baseRepo || !baseBranch) {
    return { attempted: false, reason: 'no-worktree' };
  }
  // 防重：已合并过（人工重复触发 / 事件重放）→ 跳过
  if (meta.mergedAt) {
    return { attempted: false, reason: 'already-merged' };
  }

  const title = String(meta.title ?? wu.scope ?? '').slice(0, 50);
  const scopeSummary = (wu.scope ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);

  // 数据防丢闸：worktree 有未提交改动时绝不合并/强删（下方清理是
  // `git worktree remove --force`，会静默丢弃未提交工作——e2e 实测发生过一次：
  // dev 改了未提交、合并 "Already up to date" 假成功、--force 删除丢弃改动）。
  // 转人工：WU 置 blocked + 频道列改动清单，worktree 与分支保留。
  if (worktreePath) {
    const dirtyFiles = await listDirtyFiles(worktreePath, baseRepo);
    if (dirtyFiles === null || dirtyFiles.length > 0) {
      await wuService.markMergeConflict(wu.id, dirtyFiles ?? []);
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

  const mergeCmd = `git -C ${shq(baseRepo)} merge --no-ff ${shq(branch)} -m ${shq(`merge: ${wu.id} ${scopeSummary}`)}`;

  // PMO-b（决策 3）：落档 pmoBranch 的 WU 合到 PMO 分支的集成交合 worktree
  // （不动 baseRepo 当前 checkout；冲突集中在单一合并点）。无落档 → 现状（合 baseRepo 当前分支）。
  let mergeContext: { cmd: string; cwd: string; targetBranch: string };
  if (meta.pmoBranch && meta.pmoProjectId) {
    let integration: { worktreePath: string };
    try {
      integration = await ensurePmoIntegrationWorktree({
        repoDir: baseRepo,
        worktreesDir: resolveWorktreesDir(),
        projectId: meta.pmoProjectId,
        branch: meta.pmoBranch,
        baseBranch,
      });
    } catch (err) {
      // 集成交合建不起来（如 PMO 分支被意外检出）→ 转人工，不静默回落错目标
      const message = err instanceof Error ? err.message : String(err);
      await wuService.markMergeConflict(wu.id, []);
      await postSystemMessage(
        fileStore,
        wu,
        `任务「${title}」的 PMO 集成分支 ${meta.pmoBranch} 准备失败（${message.slice(0, 200)}），已转人工处理`,
      ).catch(e => logger.warn('[MergeOnReviewPass] post pmo-setup message failed', { wuId: wu.id, error: String(e) }));
      logger.warn('[MergeOnReviewPass] pmo integration worktree setup failed', { wuId: wu.id, pmoBranch: meta.pmoBranch, error: message });
      return { attempted: true, merged: false, conflictFiles: [], reason: 'conflict' };
    }
    mergeContext = {
      cmd: `git -C ${shq(integration.worktreePath)} merge --no-ff ${shq(branch)} -m ${shq(`merge: ${wu.id} ${scopeSummary}`)}`,
      cwd: integration.worktreePath,
      targetBranch: meta.pmoBranch,
    };
  } else {
    mergeContext = { cmd: mergeCmd, cwd: baseRepo, targetBranch: baseBranch };
  }

  const merged = await tryMergeWithRebaseRetry(mergeContext.cmd, mergeContext.cwd, mergeContext.targetBranch, branch, worktreePath);
  // 注：本包 tsconfig 未开 strict，真值判断不收窄可辨识联合，须用 === false 字面量比较
  if (merged.ok === false) {
    // 转人工：WU 置 blocked + 频道系统消息（冲突文件清单）
    await wuService.markMergeConflict(wu.id, merged.conflictFiles);
    const fileList = merged.conflictFiles.length > 0
      ? `\n冲突文件：\n${merged.conflictFiles.map(f => `- ${f}`).join('\n')}`
      : '（未能获取冲突文件清单）';
    await postSystemMessage(
      fileStore,
      wu,
      `任务「${title}」自动合并到 ${mergeContext.targetBranch} 失败（重试后仍冲突），已转人工处理${fileList}`,
    ).catch(err => logger.warn('[MergeOnReviewPass] post conflict message failed', { wuId: wu.id, error: String(err) }));
    logger.warn('[MergeOnReviewPass] merge conflict escalated to human', {
      wuId: wu.id, branch, targetBranch: mergeContext.targetBranch, conflictFiles: merged.conflictFiles,
    });
    return { attempted: true, merged: false, conflictFiles: merged.conflictFiles };
  }

  // 合并成功：记录 mergeCommit（PMO-b：读集成交合 HEAD）→ 清理 worktree/分支 → 落档 metadata → 频道通知
  let mergeCommit = '';
  try {
    const { stdout } = await execSh(`git -C ${shq(mergeContext.cwd)} rev-parse HEAD`, {
      cwd: mergeContext.cwd, timeoutMs: GIT_OP_TIMEOUT_MS,
    });
    mergeCommit = stdout.trim();
  } catch (err) {
    logger.warn('[MergeOnReviewPass] rev-parse HEAD failed (mergeCommit 落空字符串)', { wuId: wu.id, error: String(err) });
  }

  if (worktreePath) {
    try {
      await execSh(`git -C ${shq(baseRepo)} worktree remove --force ${shq(worktreePath)}`, {
        cwd: baseRepo, timeoutMs: GIT_OP_TIMEOUT_MS,
      });
    } catch (err) {
      logger.warn('[MergeOnReviewPass] worktree remove failed (non-blocking)', { wuId: wu.id, worktreePath, error: String(err) });
    }
  }
  // 分支已合并（--no-ff 后是 HEAD 祖先），用安全删除 -d；失败仅留分支不阻断
  try {
    await execSh(`git -C ${shq(baseRepo)} branch -d ${shq(branch)}`, {
      cwd: baseRepo, timeoutMs: GIT_OP_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn('[MergeOnReviewPass] branch delete failed (non-blocking)', { wuId: wu.id, branch, error: String(err) });
  }

  // 落档 metadata（重读最新快照避免覆盖并发写；mergedAt 同时充当防重哨兵）
  const fresh = await wuService.getById(wu.id);
  const freshMeta = (fresh?.metadata ? JSON.parse(fresh.metadata) : {}) as WorkUnitMetadata;
  delete freshMeta.mergeConflict;
  delete freshMeta.conflictFiles;
  await wuService.update(wu.id, {
    metadata: { ...freshMeta, mergedAt: new Date().toISOString(), mergeCommit },
  });

  await postSystemMessage(
    fileStore,
    wu,
    `任务「${title}」已合并到 ${mergeContext.targetBranch}（merge commit ${mergeCommit.slice(0, 7) || '未知'}）`,
  ).catch(err => logger.warn('[MergeOnReviewPass] post merged message failed', { wuId: wu.id, error: String(err) }));
  logger.info('[MergeOnReviewPass] branch merged', { wuId: wu.id, branch, targetBranch: mergeContext.targetBranch, mergeCommit });
  return { attempted: true, merged: true, mergeCommit };
}

/** merge 一次；失败则 abort 后在 worktree rebase 到 baseBranch，再 merge 一次 */
async function tryMergeWithRebaseRetry(
  mergeCmd: string,
  baseRepo: string,
  baseBranch: string,
  branch: string,
  worktreePath?: string,
): Promise<{ ok: true } | { ok: false; conflictFiles: string[] }> {
  try {
    await execSh(mergeCmd, { cwd: baseRepo, timeoutMs: MERGE_TIMEOUT_MS });
    return { ok: true };
  } catch { /* 进入重试 */ }

  // 清理首次 merge 现场；无 worktree 无法 rebase → 直接按冲突转人工
  await abortMergeAndRebase(baseRepo);
  if (!worktreePath) {
    const conflictFiles = await listConflictFiles(baseRepo, baseRepo);
    return { ok: false, conflictFiles };
  }

  try {
    await execSh(`git -C ${shq(worktreePath)} rebase ${shq(baseBranch)}`, {
      cwd: baseRepo, timeoutMs: REBASE_TIMEOUT_MS,
    });
  } catch {
    // rebase 冲突：先取清单（abort 后现场消失），再清理
    const conflictFiles = await listConflictFiles(worktreePath, baseRepo);
    await abortMergeAndRebase(baseRepo, worktreePath);
    logger.warn('[MergeOnReviewPass] rebase onto base failed', { branch, baseBranch, conflictFiles });
    return { ok: false, conflictFiles };
  }

  try {
    await execSh(mergeCmd, { cwd: baseRepo, timeoutMs: MERGE_TIMEOUT_MS });
    return { ok: true };
  } catch {
    const conflictFiles = await listConflictFiles(baseRepo, baseRepo);
    await abortMergeAndRebase(baseRepo);
    logger.warn('[MergeOnReviewPass] merge after rebase still failed', { branch, baseBranch, conflictFiles });
    return { ok: false, conflictFiles };
  }
}
