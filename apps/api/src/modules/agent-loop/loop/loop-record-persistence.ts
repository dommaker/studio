import { withAttestation } from '@dommaker/studio-shared';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { CODE_WORKTREE_TYPES, runWuVerification } from '../wu-verification.js';
import { prepareRecordBookkeeping } from '../result-bookkeeping.js';
import type { CompletionGuardNotices } from '../completion-gates.js';
import type { StepResult } from '../agent-loop.types.js';
import type { ResultRecorderDeps } from './loop-deps.js';
import { logger } from '@dommaker/studio-shared/node';
import { reconcileTranscriptAssignments } from '../../transcripts/index.js';

/** 步骤数上限：超限强制 in_review 交人工。review WU 单独放宽——
 *  评审职责是读不是写，无提交守卫豁免后正常 ≤5 步收口；阈值仅是防死循环的安全阀 */
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;

/** 步骤安全阀上限（recordResult 强制收口用）。#471：plan 返回 null——其步数额度守卫
 *  在 agentStep 前置（PLAN_STEP_LIMIT，挂 blocked 转人续期），不走强制收口 in_review */
function stepSafetyLimit(wuType: string): number | null {
  if (wuType === 'review') return REVIEW_STEP_LIMIT;
  if (wuType === 'plan') return null;
  return STEP_LIMIT;
}

export interface ResultPersistenceInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  action: StepResult['action'];
  result: StepResult;
  guardUpdates: Partial<WorkUnitMetadata>;
  freshnessUpdates: Partial<WorkUnitMetadata>;
  notices: CompletionGuardNotices;
}

export interface ResultPersistence {
  recorded: boolean;
  stepCount: number;
  consecutiveStuck: number;
  blockReasonUpdates: Partial<WorkUnitMetadata>;
  stepLimit: number | null;
}

/** 簿记推导、F6-c 强制收口补验与单次原子写。 */
export async function persistResultBookkeeping(
  input: ResultPersistenceInput,
  deps: ResultRecorderDeps,
): Promise<ResultPersistence> {
  const { wu, metadata, action, result, guardUpdates, freshnessUpdates, notices } = input;
  const wuId = wu.id;
  // 纯簿记推导留在 AgentLoop；锁内合并归 WorkUnit ExecutionJournal。
  // guardUpdates 仍按引用传入，下方 F6-c 的追加 mutate 会在语义命令取锁后展开。
  const bookkeeping = prepareRecordBookkeeping({
    wu, metadata, action, result, guardUpdates, freshnessUpdates,
    notices: {
      verifyBlocked: notices.verifyBlocked,
      diffEmptyBlocked: notices.diffEmptyBlocked,
      contractArtifactBlocked: notices.contractArtifactBlocked,
    },
  });
  const { stepCount, consecutiveStuck, blockReasonUpdates } = bookkeeping;

  // F6-c（断点 1）：步骤超限强制收口前补跑 L1 —— COMPLETE 验证守卫只在 action=complete 时跑，
  // 超限路径（任意 action）此前完全跳过验证，代码类 WU 被强制 in_review 时永远缺 l1。
  // 台账写法与 COMPLETE 守卫同结构（approved 全绿 + verifyReport / rejected 留痕），
  // 但不计 verifyFailCount、不改 blocked 语义——仍按原计划进 in_review 交人工。
  // 本 step COMPLETE 守卫已跑过验证时不重复跑；无命令可跑 → 不写 attestation（维持现状）。
  // attestation 合进下方同一次 metadata 原子写回，不单独写库（防竞态）。
  const stepLimit = stepSafetyLimit(wu.type);
  const forceClosing = stepLimit !== null && stepCount > stepLimit;
  if (forceClosing && !notices.verifyGuardRan
    && CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    const outcome = await runWuVerification(wu, metadata, metadata.worktreePath);
    if (outcome.failure) {
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'rejected',
        by: deps.role.id,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
      });
      logger.info(`[AgentLoop] Force-close verify: l1 rejected for ${wuId} (command failed: ${outcome.failure.command})`);
    } else if (outcome.ran.length > 0) {
      guardUpdates.verifyReport = {
        commands: outcome.ran,
        source: outcome.source,
        passedAt: new Date().toISOString(),
      };
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'approved',
        by: deps.role.id,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: outcome.ran.join('；').slice(0, 300),
      });
      logger.info(`[AgentLoop] Force-close verify: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
    }
  }

  const recorded = await deps.executionJournal.recordStepResult({
    wu, metadata, action, result, guardUpdates, freshnessUpdates, bookkeeping,
  });
  if (recorded) {
    // 必须先通过 Assignment fencing 再补 terminal；完成事件在本函数返回后才发布。
    // 对账写失败保留未完成段，消费者启动/读取时会按同一快照重试。
    try {
      await reconcileTranscriptAssignments(recorded);
    } catch (err) {
      logger.warn('[AgentLoop] transcript reconcile failed (non-blocking)', { workUnitId: wuId, error: String(err) });
    }
  }
  return { recorded: Boolean(recorded), stepCount, consecutiveStuck, blockReasonUpdates, stepLimit };
}
