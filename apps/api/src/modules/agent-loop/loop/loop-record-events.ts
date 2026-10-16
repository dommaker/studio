import { withBlockedCta, type WorkUnitData, type WorkUnitMetadata } from '../../workunit/index.js';
import type { MessageMeta } from '../../channels/index.js';
import { emitWorkUnitFailedEvent } from '../execution-step-events.js';
import type { CompletionGuardNotices } from '../completion-gates.js';
import type { StepResult } from '../agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';

export interface ResultEventsInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  action: StepResult['action'];
  result: StepResult;
  guardUpdates: Partial<WorkUnitMetadata>;
  blockReasonUpdates: Partial<WorkUnitMetadata>;
  stepCount: number;
  consecutiveStuck: number;
  skipResultPost: boolean;
  stepLimit: number | null;
  traceId?: string;
  notices: CompletionGuardNotices;
}

export interface ResultEventsDeps {
  host: AgentLoopHost;
  postToDiscussionSpace: (
    workUnitId: string,
    content: string,
    milestoneWu?: WorkUnitData,
    extraMeta?: MessageMeta,
  ) => Promise<void>;
}

/** 原子写后的通知、失败事件与状态迁移。 */
export async function dispatchResultEvents(
  input: ResultEventsInput,
  deps: ResultEventsDeps,
): Promise<void> {
  const {
    wu, metadata, action, result, guardUpdates, blockReasonUpdates,
    stepCount, consecutiveStuck, skipResultPost, stepLimit, traceId, notices,
  } = input;
  const { host, postToDiscussionSpace } = deps;
  const wuId = wu.id;

  // §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零，之后每 3 步再提醒）
  if (notices.noCommit) {
    await postToDiscussionSpace(wuId, `任务 ${wuId} 连续 3 步无新提交，请注意及时 commit`);
  }

  // B3b-i: 自动验证连续失败 ≥3 次 → blocked 并频道说明（优先于 step limit / 状态迁移）
  if (notices.verifyBlocked) {
    // #178（#63 决议 2）：状态迁移前 fencing，易主即静默退出
    if (wu.status !== 'blocked' && !(await host.transitionIfHeld(wuId, 'blocked'))) return;
    // #172（#60 决策 Q1）：WU 级终态失败事件落盘（level=warning，#62 失败趋势探测数据源）
    void emitWorkUnitFailedEvent({
      workUnitId: wuId,
      failureType: 'verify_failed',
      blockReason: String(blockReasonUpdates.blockReason ?? ''),
      consecutiveStuck,
      attempts: stepCount,
      totalDurationMs: Math.max(0, Date.now() - new Date(wu.createdAt).getTime()),
      traceId,
    }).catch(() => {});
    // 2026-07 PMO-flow UX（§6-3）：验证失败打回/转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
    // #176（决策 #57 D3-1）：blocked 里程碑统一携带 CTA 行动召唤块
    await postToDiscussionSpace(
      wuId,
      withBlockedCta(
        `自动验证连续失败 ${guardUpdates.verifyFailCount} 次，任务已转 blocked，等待人类介入。最近失败命令与输出已记录到任务上下文`,
        String(blockReasonUpdates.blockReason ?? ''),
      ),
      wu,
    );
    return;
  }

  // 收口闸（产出实）：空 diff / 契约产物连续打回 ≥3 次 → blocked 并频道说明（模式同 verifyBlocked）
  const outputGateBlocked = notices.diffEmptyBlocked
    ? {
        failureType: 'diff_empty',
        message: `连续 ${guardUpdates.diffEmptyCount} 次报告完成却没有任何提交内容，任务已转 blocked，等待人类介入`,
      }
    : notices.contractArtifactBlocked
      ? {
          failureType: 'contract_artifact',
          message: `契约产物连续缺失 ${guardUpdates.contractArtifactCount} 次，任务已转 blocked，等待人类介入。缺失产物与提示已记录到任务上下文`,
        }
      : null;
  if (outputGateBlocked) {
    // #178（#63 决议 2）：状态迁移前 fencing，易主即静默退出
    if (wu.status !== 'blocked' && !(await host.transitionIfHeld(wuId, 'blocked'))) return;
    // #172（#60 决策 Q1）：WU 级终态失败事件落盘（level=warning，#62 失败趋势探测数据源）
    void emitWorkUnitFailedEvent({
      workUnitId: wuId,
      failureType: outputGateBlocked.failureType,
      blockReason: String(blockReasonUpdates.blockReason ?? ''),
      consecutiveStuck,
      attempts: stepCount,
      totalDurationMs: Math.max(0, Date.now() - new Date(wu.createdAt).getTime()),
      traceId,
    }).catch(() => {});
    // #176（决策 #57 D3-1）：blocked 里程碑统一携带 CTA 行动召唤块
    await postToDiscussionSpace(
      wuId,
      withBlockedCta(outputGateBlocked.message, String(blockReasonUpdates.blockReason ?? '')),
      wu,
    );
    return;
  }

  // B3b-i: 验证全绿 → 频道简报（跑了哪几条；仅当 COMPLETE 未被其他守卫拦截）
  if (notices.verifyPassed && action === 'complete') {
    await postToDiscussionSpace(wuId, notices.verifyPassed);
  }

  // Monitoring: step limit（review WU 用放宽阈值，见 REVIEW_STEP_LIMIT 注释；plan 无强制收口——额度守卫在 agentStep 前置，#471）
  if (stepLimit !== null && stepCount > stepLimit) {
    // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
    // #178（#63 决议 2）：状态迁移前 fencing，易主即静默退出
    if (wu.status === 'blocked' && !(await host.transitionIfHeld(wuId, 'active'))) return;
    if (!(await host.transitionIfHeld(wuId, 'in_review'))) return;
    await postToDiscussionSpace(wuId, '步骤数超限，强制提交审查');
    return;
  }
  // Monitoring: stuck detection
  if (consecutiveStuck >= 3) {
    // #178（#63 决议 2）：状态迁移前 fencing，易主即静默退出
    if (!(await host.transitionIfHeld(wuId, 'blocked'))) return;
    // #172（#60 决策 Q1）：WU 级终态失败事件落盘（level=warning）。
    // failureType 取本步 errorType（execution_failed / worktree_creation_failed 等），
    // 无 errorType 的纯停滞（连续 need_input/progress 无进展）记 'stuck'。
    void emitWorkUnitFailedEvent({
      workUnitId: wuId,
      failureType: typeof metadata.errorType === 'string' && metadata.errorType
        ? metadata.errorType
        : action === 'failed' ? 'execution_failed' : 'stuck',
      blockReason: String(blockReasonUpdates.blockReason ?? ''),
      consecutiveStuck,
      attempts: stepCount,
      totalDurationMs: Math.max(0, Date.now() - new Date(wu.createdAt).getTime()),
      traceId,
    }).catch(() => {});
    // W-3 接线：执行失败导致的 blocked 在频道说明失败原因（summary 含 CLI 错误详情）
    const stuckReason = action === 'failed' && result.summary ? `（${result.summary}）` : '';
    // 2026-07 PMO-flow UX（§6-3）：blocked 转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
    // #176（决策 #57 D3-1）：blocked 里程碑统一携带 CTA 行动召唤块
    await postToDiscussionSpace(
      wuId,
      withBlockedCta(`连续 3 步无进展${stuckReason}，等待人类介入`, String(blockReasonUpdates.blockReason ?? '')),
      wu,
    );
    return;
  }

  // State transitions by action (§10.5: 使用守卫降级后的 action；§4.2: 新鲜度拦截时不发帖)
  // #178（#63 决议 2）：全部迁移走 transitionIfHeld（迁移前 fencing，易主即静默退出）。
  // 非空守卫：summary 为空（如 CLI 成功但无文本输出）不发帖，避免频道空消息。
  switch (action) {
    case 'progress':
      if (!skipResultPost && result.summary.trim().length > 0) await postToDiscussionSpace(wuId, result.summary);
      if (wu.status === 'blocked' && !(await host.transitionIfHeld(wuId, 'active'))) return;
      break;
    case 'complete':
      // 2026-07 PMO-flow UX（§6-3）：COMPLETE 完成汇报里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      if (!skipResultPost && result.summary.trim().length > 0) {
        await postToDiscussionSpace(wuId, result.summary, wu);
      }
      // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
      if (wu.status === 'blocked' && !(await host.transitionIfHeld(wuId, 'active'))) return;
      if (!(await host.transitionIfHeld(wuId, 'in_review'))) return;
      // P0 修复（reviewReport 回传断链）：review 子 WU 不再被二次评审
      // （ReviewDispatcher 路径 A 跳过 type=review），complete 后直接收口 done，
      // 触发路径 B 读取 metadata.reviewReport 判定父 WU reviewPassed/reviewRejected。
      if (wu.type === 'review' && !(await host.transitionIfHeld(wuId, 'done'))) return;
      break;
    case 'need_input':
      // 2026-07 PMO-flow UX（§6-3）：NEED_INPUT 里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      // #279（决策 #250 D3）：result.options 存在时随 meta 透传，供前端渲染选项卡
      // #467：result.rulings 存在时 meta.cardType='plan_ruling'——前端渲染裁决轮接力卡
      // #567：result.directions 存在时 meta.cardType='plan_direction'——前端渲染方向接力卡
      //   （方向是裁决轮前置环节，并存时 direction 优先）
      if (!skipResultPost) {
        const extraMeta: MessageMeta = {};
        if (result.options?.length) extraMeta.options = result.options;
        if (result.rulings?.length) extraMeta.cardType = 'plan_ruling';
        if (result.directions) extraMeta.cardType = 'plan_direction';
        await postToDiscussionSpace(wuId, `需要输入: ${result.summary}`, wu,
          Object.keys(extraMeta).length > 0 ? extraMeta : undefined);
      }
      // F5: 挂起 — 守卫重复 NEED_INPUT（blocked → blocked 不在 VALID_TRANSITIONS 中）
      // #178（#63 决议 2）：状态迁移前 fencing，易主即静默退出
      if (wu.status !== 'blocked' && !(await host.transitionIfHeld(wuId, 'blocked'))) return;
      break;
    case 'failed':
      // W-3 接线 + #175（#55 决策 2）：CLI 执行失败 —— 发一条「执行失败（第 N 次）：原因截断」
      // 普通系统消息（不带里程碑 meta、不过 §4.2 新鲜度闸），不做状态迁移（保持 active 待重试）；
      // 重试不单独发声，下次成功的 progress 自然翻篇。consecutiveStuck 已在上方累计，
      // 满 3 次在上方 blocked 里程碑路径 return（第 3 次不额外发声），走到这里 N ∈ {1,2}。
      await postToDiscussionSpace(
        wuId,
        `『${host.role.name}』执行失败（第 ${consecutiveStuck} 次）：${(result.summary ?? '').slice(0, 200)}`,
      );
      break;
  }
}
