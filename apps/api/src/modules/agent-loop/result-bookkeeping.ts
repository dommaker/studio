/**
 * recordResult 的纯簿记推导：计数、F5 挂起标记和 blocked 原因。
 * 原子合并规则归 WorkUnit ExecutionJournal；本模块不再构造或暴露 mutator。
 */

import type { WorkUnitData, WorkUnitMetadata, StepBookkeeping } from '../workunit/index.js';
import type { StepResult } from './agent-loop.js';

export interface RecordBookkeepingInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  action: StepResult['action'];
  result: StepResult;
  guardUpdates: Partial<WorkUnitMetadata>;
  freshnessUpdates: Partial<WorkUnitMetadata>;
  notices: { verifyBlocked: boolean; diffEmptyBlocked: boolean; contractArtifactBlocked: boolean };
}

export type RecordBookkeeping = StepBookkeeping;

export function prepareRecordBookkeeping(input: RecordBookkeepingInput): RecordBookkeeping {
  const { wu, metadata, action, result, guardUpdates, freshnessUpdates } = input;
  const { verifyBlocked, diffEmptyBlocked, contractArtifactBlocked } = input.notices;

  const stepCount = (metadata.stepCount ?? 0) + 1;
  const consecutiveStuck = action === 'progress' ? 0 : (metadata.consecutiveStuck ?? 0) + 1;

  // #95: progressLog 环形簿记 —— 只记成功步（progress/complete；delegate 经 handleDelegateBranch
  // 已归化为 progress/need_input，failed/need_input 不进 log），summary 截 200 字符、保留最近 5 条。
  // 失败步不落 log：errorType 留在 metadata，由 prompt-composer 注入「前序进展」段时附「上一步失败」行。
  // #170（决策 #65-1）：追加动作随下方 updateMetadata 移入锁内（基于锁内最新 progressLog，
  // 不再用读时快照拼接后全量回写）。

  // F5: NEED_INPUT 挂起标记（等待人类回复）；其他结果清除挂起标记（恢复后继续执行）
  const waitingUpdates: Partial<WorkUnitMetadata> = action === 'need_input'
    ? {
        waitingForInput: true,
        waitingQuestion: result.summary,
        waitingSince: new Date().toISOString(),
        waitingReminded: false,
        // #467：裁决轮——RULING 行落档（裁决卡预填数据源）+ 挂起原因标记；
        // 人提交裁决（POST /:id/ruling → pmo/plan-ruling.ts）后清除
        ...(result.rulings?.length
          ? { planRulings: result.rulings, waitingReason: 'plan-ruling' }
          : {}),
        // #567：方向锁定——DIRECTION 行落档（方向接力卡预填数据源）+ 挂起原因标记；
        // 与 rulings 并存时 direction 优先定 waitingReason（方向是裁决轮前置环节）；
        // 人提交选定（POST /:id/direction → pmo/plan-direction.ts）后清除
        ...(result.directions
          ? { planDirections: result.directions, waitingReason: 'plan-direction' }
          : {}),
      }
    : metadata.waitingForInput
      ? { waitingForInput: false, waitingReminded: false }
      : {};

  // B4（2026-08-03 token-burn issue P0-2）：blocked 原因落盘 —— 审计类 WU 全部 blocked
  // 却无据可查的事故教训；本步不走 blocked 路径时清除陈旧原因（恢复执行即翻篇）。
  const blockReasonUpdates: Partial<WorkUnitMetadata> = {};
  if (verifyBlocked) {
    blockReasonUpdates.blockReason = `verify-failed x${guardUpdates.verifyFailCount}: 自动验证连续失败`;
  } else if (diffEmptyBlocked) {
    blockReasonUpdates.blockReason = `diff-empty x${guardUpdates.diffEmptyCount}: 报告完成但无提交内容`;
  } else if (contractArtifactBlocked) {
    blockReasonUpdates.blockReason = `contract-artifact x${guardUpdates.contractArtifactCount}: 契约产物连续缺失`;
  } else if (consecutiveStuck >= 3) {
    blockReasonUpdates.blockReason = action === 'failed' && result.summary
      ? `stuck: 连续 3 步无进展（${result.summary.slice(0, 200)}）`
      : 'stuck: 连续 3 步无进展';
  } else if (action === 'need_input') {
    blockReasonUpdates.blockReason = `need-input: ${result.summary.slice(0, 200)}`;
  } else if (metadata.blockReason) {
    blockReasonUpdates.blockReason = undefined; // undefined 在 JSON 序列化时丢弃 → 清除
  }

  return { stepCount, consecutiveStuck, waitingUpdates, blockReasonUpdates };
}
