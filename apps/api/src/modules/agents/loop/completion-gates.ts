/**
 * 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）：
 * recordResult 的 COMPLETE 收口判定 —— §10.5 提交守卫 → §6-2 子任务守卫 → B3b-i 自动验证守卫。
 * 顺序即优先级：前面的守卫把 action 降级为 progress 后，后面的 COMPLETE 守卫自然不再触发。
 *
 * 职责边界：
 *   - 本模块 = 守卫政策（guard policy）：判定/降级/hint 写入/l1 台账写法/no-commit 计数。
 *   - agent-loop.recordResult = 编排：构建合并视图（持久化 + 本 step metadataUpdates）→
 *     调 runCompletionGuards → delegate/新鲜度/强制收口补跑 → 单次原子写 → 状态迁移与频道通知。
 *   - agent-loop.agentStep = hint 消费（读 metadata 注入 prompt 后清除），属 prompt 组装，不在本模块。
 *
 * 可测试性：git/验证/子任务查询全部经 deps 注入，单测用纯 ctx 对象驱动，无需 vi.mock 模块工厂。
 * 默认实现（hasUncommittedChanges/readHeadHash/runWuVerification）与原 AgentLoop 私有方法逐字一致。
 */

import { execSync } from 'child_process';
import { logger, withAttestation } from '@dommaker/studio-shared';
import { CODE_WORKTREE_TYPES, runWuVerification, type WuVerifyOutcome } from './wu-verification.js';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { StepResult } from './agent-loop.js';

/** §10.5 提交守卫：worktree 是否有未提交改动。
 *  git 调用失败返回 false —— 守卫静默跳过，绝不因基础设施故障阻断完成。 */
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

/** 守卫链输入。metadata 必须是「持久化 + 本 step metadataUpdates」的合并视图（调用方构建）：
 *  首个 step 的 worktreePath 等字段由 agentStep 经 result.metadataUpdates 传入、此刻尚未落库；
 *  只看持久化值会让首 step 的 COMPLETE 退到主仓库（干净）做检查而漏拦。 */
export interface CompletionGuardCtx {
  wu: WorkUnitData;
  wuId: string;
  metadata: WorkUnitMetadata;
  action: StepResult['action'];
  /** attestation.by 落档用（profile id） */
  roleId: string;
}

/** 守卫链外部依赖。git/验证默认实现即原 AgentLoop 私有方法/wu-verification，单测整体注入伪实现。 */
export interface CompletionGuardDeps {
  /** B3b-i: 提交守卫的 git cwd 解析（代码类 → 专属 worktree；否则回退 B3a/F6 共享根） */
  resolveExecutionCwd: (wu: WorkUnitData, metadata: WorkUnitMetadata) => Promise<string | null>;
  /** §6-2: 未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
  listUnfinishedChildren: (wuId: string) => Promise<string[]>;
  hasUncommittedChanges?: (cwd: string) => boolean;
  readHeadHash?: (cwd: string) => string | null;
  runVerification?: (wu: WorkUnitData, metadata: WorkUnitMetadata, worktreePath: string) => Promise<WuVerifyOutcome>;
}

/** 守卫链产生的后续动作信号（recordResult 据此发频道通知/跑强制收口补验/转 blocked） */
export interface CompletionGuardNotices {
  /** §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零） */
  noCommit: boolean;
  /** B3b-i: 验证全绿频道简报文案（仅当 action 最终仍为 complete 才发，recordResult 判定） */
  verifyPassed: string | null;
  /** B3b-i: verifyFailCount ≥3 → blocked 并频道说明 */
  verifyBlocked: boolean;
  /** F6-c：本 step COMPLETE 守卫是否已跑过验证 —— 步骤超限强制收口路径据此避免重复跑 */
  verifyGuardRan: boolean;
}

export interface CompletionGuardOutcome {
  action: StepResult['action'];
  /** 守卫写入的 metadata 增量（hint/计数/台账/verifyReport），由 recordResult 合进原子写 */
  guardUpdates: Partial<WorkUnitMetadata>;
  notices: CompletionGuardNotices;
}

/**
 * 依次跑三条收口守卫（顺序即优先级，任一降级后后续 COMPLETE 守卫不再触发）：
 *  1. §10.5 提交守卫：COMPLETE + 未提交改动 → 降级 progress + commitGuardHint；
 *     PROGRESS 无提交监视（lastCommitHash/noCommitSteps，≥3 → noCommit notice + 归零）。
 *     review WU 整体豁免（评审职责是读不是写）；路径解析/git 失败一律静默跳过。
 *  2. §6-2 子任务守卫：存在未完结子 WU → 降级 progress + childGuardHint。
 *  3. B3b-i 自动验证守卫：代码类 WU 有 worktreePath 才跑（runWuVerification）；
 *     失败 → verifyFailCount++/verifyFailHint/l1 rejected 台账/降级，≥3 → verifyBlocked；
 *     全绿 → verifyReport + l1 approved 台账 + verifyPassed 简报。
 */
export async function runCompletionGuards(
  ctx: CompletionGuardCtx,
  deps: CompletionGuardDeps,
): Promise<CompletionGuardOutcome> {
  const { wu, wuId, metadata, roleId } = ctx;
  const dirty = deps.hasUncommittedChanges ?? hasUncommittedChanges;
  const headHash = deps.readHeadHash ?? readHeadHash;
  const verify = deps.runVerification ?? runWuVerification;

  let action = ctx.action;
  const guardUpdates: Partial<WorkUnitMetadata> = {};
  const notices: CompletionGuardNotices = {
    noCommit: false,
    verifyPassed: null,
    verifyBlocked: false,
    verifyGuardRan: false,
  };

  // §10.5 提交守卫（发生在状态迁移之前，与 stepCount 守卫同层 —— 不动 VALID_TRANSITIONS）。
  // 路径解析或 git 调用失败一律静默跳过，绝不因基础设施故障阻断完成。
  // B3b-i: cwd 走 resolveExecutionCwd —— 代码类 WU 在专属 worktree 下跑 git status。
  // review WU 整体豁免：评审职责是读不是写（cwd 解析到父 WU worktree，dev 的提交/
  // 工具产物与评审无关），工作区洁净不是它的责任——否则 COMPLETE 被反复打回空转。
  const workspaceRoot = wu.type === 'review' ? null : await deps.resolveExecutionCwd(wu, metadata);
  if (workspaceRoot) {
    if (action === 'complete' && dirty(workspaceRoot)) {
      // COMPLETE 守卫：有未提交改动 → 打回按 PROGRESS 处理，提示注入下一轮 prompt
      action = 'progress';
      guardUpdates.commitGuardHint = '有未提交改动，请先 git add/commit 再报告完成';
      logger.info(`[AgentLoop] Commit guard: COMPLETE downgraded for ${wuId} (uncommitted changes)`);
    }
    if (action === 'progress') {
      // PROGRESS 无提交监视：HEAD 不变 → 累计；连续 3 步发一次频道提醒并归零
      const head = headHash(workspaceRoot);
      if (head) {
        if (metadata.lastCommitHash === head) {
          const next = (metadata.noCommitSteps ?? 0) + 1;
          if (next >= 3) {
            notices.noCommit = true;
            guardUpdates.noCommitSteps = 0;
          } else {
            guardUpdates.noCommitSteps = next;
          }
        } else {
          guardUpdates.lastCommitHash = head;
          guardUpdates.noCommitSteps = 0;
        }
      }
    }
  }

  // §6-2 父 complete 守卫（与提交守卫同层，同一降级为 progress 的模式）：
  // 存在未完结（unassigned/active/blocked/in_review）子 WU 时不允许 complete ——
  // 父一旦抢先 in_review，聚合的状态序防回退会让「子后完成」无法改写父状态（收口顺序：父必须等子）。
  if (action === 'complete') {
    const unfinishedChildren = await deps.listUnfinishedChildren(wuId);
    if (unfinishedChildren.length > 0) {
      action = 'progress';
      guardUpdates.childGuardHint = `存在未完结子任务（${unfinishedChildren.join(', ')}），等待其全部完成后再报告 COMPLETE`;
      logger.info(`[AgentLoop] Child guard: COMPLETE downgraded for ${wuId} (unfinished children: ${unfinishedChildren.length})`);
    }
  }

  // B3b-i（决策 D3 前半）: COMPLETE 前自动验证 —— 仅代码类 WU（有专属 worktree）。
  // 提交守卫/子任务守卫已通过（action 仍为 complete）才跑；命令解析：覆盖 > 约定（见 resolveVerifyCommands）。
  // 全绿 → verifyReport 落档 + 频道简报；任一失败 → 降级 progress，失败命令+输出尾部注入下一轮 prompt，
  // verifyFailCount ≥3 → blocked。无 worktree / 无命令可跑 → 跳过（维持现状）。
  if (action === 'complete'
    && CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    const outcome = await verify(wu, metadata, metadata.worktreePath);
    notices.verifyGuardRan = true;
    if (outcome.failure) {
      const failCount = (metadata.verifyFailCount ?? 0) + 1;
      guardUpdates.verifyFailCount = failCount;
      guardUpdates.verifyFailHint = [
        `自动验证未通过（第 ${failCount} 次），请先修复再报告完成`,
        `失败命令: ${outcome.failure.command}`,
        `输出尾部:\n${outcome.failure.tail}`,
      ].join('\n');
      // F6（决策 1）：验证失败同样落台账 l1（rejected 留痕，后续全绿 approved 覆盖）
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'rejected',
        by: roleId,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
      });
      action = 'progress';
      notices.verifyBlocked = failCount >= 3;
      logger.info(`[AgentLoop] Verify guard: COMPLETE downgraded for ${wuId} (command failed: ${outcome.failure.command}, count ${failCount})`);
    } else {
      guardUpdates.verifyFailCount = 0;
      if (outcome.ran.length > 0) {
        guardUpdates.verifyReport = {
          commands: outcome.ran,
          source: outcome.source,
          passedAt: new Date().toISOString(),
        };
        // F6（决策 1）：验证全绿落台账 l1
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'approved',
          by: roleId,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: outcome.ran.join('；').slice(0, 300),
        });
        notices.verifyPassed = `✅ 自动验证通过（${outcome.ran.length} 条）：${outcome.ran.join('；')}`;
        logger.info(`[AgentLoop] Verify guard: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
      }
    }
  }

  return { action, guardUpdates, notices };
}
