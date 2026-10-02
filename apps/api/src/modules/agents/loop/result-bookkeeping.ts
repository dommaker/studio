/**
 * recordResult 簿记段（#655 从 agent-loop.recordResult 抽出，行为一字不改）：
 * stepCount/consecutiveStuck 推导 → F5 NEED_INPUT 挂起标记（#467 裁决轮 / #567 方向锁定）
 * → B4 blocked 原因落盘 → #170（决策 #65-1）锁内字段级合并 mutator 工厂
 * （progressLog 环形追加 + pendingReplies 三段合成，全部锁内基于最新值计算）。
 *
 * 职责边界：
 *   - 本模块 = recordResult 簿记段：计数/挂起/blocked 原因推导 + updateMetadata mutator 构建。
 *   - agent-loop.recordResult = 编排：B2 skipped 守卫 / 租约 fencing / 合并视图构建 /
 *     runCompletionGuards / delegate 分支 / §4.2 新鲜度检查 / F6-c 强制收口补验 /
 *     updateMetadata 调用本身与其后的通知、状态迁移，全部留在 agent-loop。
 *
 * 关键保真点：recordResult 在簿记推导之后、updateMetadata 之前的 F6-c 强制收口段会追加
 * mutate guardUpdates（写 attestations/verifyReport）；mutator 按引用闭包同一个
 * guardUpdates 对象，展开（...guardUpdates）发生在锁内调用时而非工厂构建时，
 * 后续 mutate 才会被包含。编排侧调用顺序保持：新鲜度段 → prepareRecordBookkeeping →
 * F6-c 段 → updateMetadata(mutator)。
 *
 * 可测试性：纯函数零外部 I/O（无 deps 注入面），单测用纯 input 对象驱动，无需
 * vi.mock 模块工厂（对称 completion-gates / step-guards 的可测试性契约）。
 */

import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { parseWuMetadata } from '../../workunit/index.js';
import type { StepResult } from './agent-loop.js';

/** #95: progressLog 环形簿记——保留最近成功步条数上限 */
const PROGRESS_LOG_MAX_ENTRIES = 5;
/** #95: progressLog 单条 summary 截断字符上限 */
const PROGRESS_LOG_SUMMARY_MAX_CHARS = 200;

export interface RecordBookkeepingInput {
  wu: WorkUnitData;                       // 供 parseWuMetadata(wu.metadata) 取 persisted pendingReplies 计数
  metadata: WorkUnitMetadata;             // 合并视图（持久化 + 本 step metadataUpdates）
  action: StepResult['action'];           // 守卫/delegate/新鲜度降级后的最终 action
  result: StepResult;
  guardUpdates: Partial<WorkUnitMetadata>;
  freshnessUpdates: Partial<WorkUnitMetadata>;
  notices: { verifyBlocked: boolean; diffEmptyBlocked: boolean; contractArtifactBlocked: boolean };
}

export interface RecordBookkeeping {
  stepCount: number;
  consecutiveStuck: number;
  waitingUpdates: Partial<WorkUnitMetadata>;
  blockReasonUpdates: Partial<WorkUnitMetadata>;
  /** 交给 fileStore.updateMetadata(wuId, mutator) 的 mutator 工厂产物 */
  mutator: (latestRaw: Record<string, unknown>) => Record<string, unknown>;
}

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

  // #170（决策 #65-1）：锁内字段级合并写 —— 守卫/新鲜度/强制收口判定仍在锁外基于合并视图
  // 完成，最终只把本步字段级增量交给 updateMetadata 的 mutator 应用到锁内最新 metadata：
  // stepCount/consecutiveStuck 锁内重计、progressLog 锁内基于最新值追加、pendingReplies
  // 三段合成（精确移除本步已注入的旧条目；保留 step 期间经 waiting-input 锁内新到的人类
  // 回复；尾部追加新鲜度拦截暂存），其余增量覆盖到最新值——人类回复/扫描计数不再被
  // recordResult 的陈旧快照全量回写冲掉（#58-M1 扫描计数回退一并消除）。
  const persistedMeta = parseWuMetadata(wu.metadata);
  const stepStartReplyCount = Array.isArray(persistedMeta.pendingReplies) ? persistedMeta.pendingReplies.length : 0;
  // prompt-composer 消费清除标记：metadataUpdates 携带 pendingReplies: undefined = 本步已注入
  const stepUpdates = result.metadataUpdates ?? {};
  const consumedPending = 'pendingReplies' in stepUpdates && stepUpdates.pendingReplies === undefined;
  const freshnessHeld = Array.isArray(freshnessUpdates.pendingReplies) ? freshnessUpdates.pendingReplies : [];

  const mutator = (latestRaw: Record<string, unknown>): Record<string, unknown> => {
    const latest = latestRaw as WorkUnitMetadata;
    const nextStepCount = (latest.stepCount ?? 0) + 1;
    const next: WorkUnitMetadata = {
      ...latest,
      ...stepUpdates,
      ...waitingUpdates,
      ...guardUpdates,
      ...freshnessUpdates,
      ...blockReasonUpdates,
      stepCount: nextStepCount,
      consecutiveStuck: action === 'progress' ? 0 : (latest.consecutiveStuck ?? 0) + 1,
    };
    // progressLog 环形簿记：锁内基于最新值尾部追加（截 200 字符、保留最近 5 条）
    if (action === 'progress' || action === 'complete') {
      const prevLog = Array.isArray(latest.progressLog) ? latest.progressLog : [];
      next.progressLog = [...prevLog, {
        step: nextStepCount,
        action,
        summary: (result.summary ?? '').slice(0, PROGRESS_LOG_SUMMARY_MAX_CHARS),
        at: new Date().toISOString(),
      }].slice(-PROGRESS_LOG_MAX_ENTRIES);
    }
    // pendingReplies 三段合成（追加只发生在尾部 → slice 精确移除本步已注入的旧条目）
    let replies = Array.isArray(latest.pendingReplies) ? [...latest.pendingReplies] : [];
    if (consumedPending) replies = replies.slice(stepStartReplyCount);
    if (freshnessHeld.length > 0) replies.push(...freshnessHeld);
    if (replies.length > 0) next.pendingReplies = replies;
    else delete next.pendingReplies;
    return next as Record<string, unknown>;
  };

  return { stepCount, consecutiveStuck, waitingUpdates, blockReasonUpdates, mutator };
}
