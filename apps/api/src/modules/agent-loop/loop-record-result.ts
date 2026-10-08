/**
 * 结果记录段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * recordResult 步结果回写编排——B2 skipped 短路 → #178 fencing（步结果回写前比对
 * claimedAt 代际令牌，易主即静默退出）→ 合并视图构建 → 收口守卫链（./completion-gates.js）
 * → A2A DELEGATE 分支（./delegate-branch.js）→ §4.2 发言层新鲜度检查 → 簿记段
 * （./result-bookkeeping.js）→ F6-c 步骤超限强制收口补验 → 单次原子写 →
 * verifyBlocked / 产出实双闸 / 步骤超限 / 停滞检测 / 按 action 状态迁移与频道通知。
 * 附带 listUnfinishedChildren（§6-2 父 complete 守卫）与 postToDiscussionSpace
 * （频道系统消息唯一出口，经 host seam 供 claim/step 段共用）。
 * 全部共享状态经 AgentLoopHost 读写；本类零自有状态。
 */
import { logger, withAttestation } from '@dommaker/studio-shared';
import {
  mergedWuView, withBlockedCta, postWuSystemMessage,
  type WorkUnitData, type WorkUnitMetadata,
} from '../workunit/index.js';
import type { MessageMeta } from '../channels/index.js';
import { emitWorkUnitFailedEvent } from './execution-step-events.js';
import { CODE_WORKTREE_TYPES, runWuVerification } from './wu-verification.js';
import { runCompletionGuards } from './completion-gates.js';
import { prepareRecordBookkeeping } from './result-bookkeeping.js';
import { handleDelegateBranch } from './delegate-branch.js';
import { resolveExecutionCwd } from './execution-cwd.js';
import type { StepResult, Target } from './agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';

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

export class ResultRecorder {
  constructor(private readonly host: AgentLoopHost) {}

  /** Record result: monitoring checkpoints + state transitions (zero token) */
  async recordResult(target: Target, result: StepResult): Promise<void> {
    const host = this.host;
    // B2: 测试特征 WU 守卫已在 agentStep 自行关闭 WU 并留痕，无需任何簿记/状态迁移
    if (result.action === 'skipped') return;
    const wuId = target.workUnit.id;
    const wu = await host.workUnitService.getById(wuId);
    if (!wu) return;

    // #178（#63 决议 2）：fencing —— 步结果回写前比对 claimedAt 代际令牌。
    // 易主（超时释放后被他人认领 / 释放回池）→ 放弃回写、杀自身 CLI 进程组、
    // 停止心跳、静默退出（旧 holder 一字不再写，新 holder 的上下文不被污染）。
    if (!(await host.stillHoldsLease(wuId))) {
      await host.handleLeaseLost(wuId, 'lost');
      return;
    }

    // 提交守卫/自动验证必须以「持久化 + 本 step metadataUpdates」的合并视图为准
    // （首 step 的 worktreePath 尚未落库，只看持久化值会漏拦 → 假 complete；
    //   完整事故实录与 undefined-清除口径见 workunit/wu-metadata.ts mergedWuView）
    const metadata: WorkUnitMetadata = mergedWuView(wu.metadata, result.metadataUpdates);
    // P0 修复 6: traceId（与 agentStep 同一来源，供日志行携带）
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // 收口守卫链（§10.5 提交守卫 → §6-2 子任务守卫 → 产出实双闸（空 diff / 契约产物）→ B3b-i 自动验证守卫）已抽到
    // ./completion-gates.js（行为一字不改，含守卫顺序/hint 写法/l1 台账/合并视图口径）——
    // recordResult 只保留编排：构建合并视图（上方）→ 跑守卫 → delegate/新鲜度/强制收口 →
    // 单次原子写 → 状态迁移与频道通知。git/子任务查询经 deps 注入（loop 绑定的两个方法下传）。
    const cwdDeps = { getWuById: (id: string) => host.workUnitService.getById(id) };
    const guards = await runCompletionGuards(
      { wu, wuId, metadata, action: result.action, roleId: host.role.id },
      {
        resolveExecutionCwd: (w, m) => resolveExecutionCwd(w, m, cwdDeps),
        listUnfinishedChildren: id => this.listUnfinishedChildren(id),
      },
    );
    let action = guards.action;
    const guardUpdates = guards.guardUpdates;
    const noCommitNotice = guards.notices.noCommit;
    const verifyBlocked = guards.notices.verifyBlocked;
    const verifyPassNotice = guards.notices.verifyPassed;
    // 收口闸（产出实）：空 diff / 契约产物连续打回 ≥3 次 → blocked（模式同 verifyBlocked）
    const diffEmptyBlocked = guards.notices.diffEmptyBlocked;
    const contractArtifactBlocked = guards.notices.contractArtifactBlocked;
    // F6-c：本 step COMPLETE 守卫是否已跑过验证 —— 下方步骤超限强制收口路径据此避免重复跑
    const verifyGuardRan = guards.notices.verifyGuardRan;

    // A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）后的委派政策
    // （通过：建子单 + collab 元数据 + delegate 卡片，父 WU 按 progress 继续；
    //  拒绝：降级 NEED_INPUT 请人裁决）已抽到 ./delegate-branch.js（2026-08 工单 05，行为不变）。
    if (action === 'delegate' && result.delegate) {
      const d = await handleDelegateBranch(
        { wu, wuId, delegate: result.delegate },
        { fileStore: host.fileStore, role: host.role, createWorkUnit: input => host.workUnitService.create(input) },
      );
      action = d.action;
      result.summary = d.summary;
      if (d.collabUpdate) guardUpdates.collab = d.collabUpdate;
    }

    // §4.2 发言层新鲜度检查（仅 recordResult → postToDiscussionSpace 结果回帖路径，系统通知不受影响）：
    // step 期间房间有外部新消息 → 不直接发帖，新消息写入 pendingReplies 注入下一轮 prompt，
    // 本步按 progress 处理；同一结果连续 2 次被拦截仍判定要发 → 照发并注明「发送时房间有新消息」。
    let skipResultPost = false;
    const freshnessUpdates: Partial<WorkUnitMetadata> = {};
    if (result.channelVersion && wu.channelId) {
      // #319：锚点 = 快照时最后一行消息 id（压实安全）；锚点行若已被压实抹除，
      // getMessagesSince 保守返回全部活消息，经下方「自己消息过滤 + 2 次拦截后照发」有界消化
      const arrived = await host.fileStore.getMessagesSince(wu.channelId, result.channelVersion.lastMessageId);
      // 本 loop 自己发的消息（如 delegate 卡片）不算「房间已变」
      const external = arrived.filter(m => !(m.authorType === 'agent' && m.agentName === host.role.name));
      const interrupts = metadata.freshnessInterrupts ?? 0;
      if (external.length > 0 && interrupts < 2) {
        skipResultPost = true;
        action = 'progress';
        freshnessUpdates.pendingReplies = external.map(m =>
          m.authorType === 'agent' ? `[${m.agentName ?? 'agent'}]: ${m.content}` : m.content
        );
        freshnessUpdates.freshnessInterrupts = interrupts + 1;
        logger.info(`[AgentLoop] Freshness: result post held for ${wuId} (${external.length} new message(s), interrupt ${interrupts + 1}/2)`);
      } else {
        if (external.length > 0) {
          result.summary = `${result.summary}（发送时房间有新消息）`;
        }
        if (interrupts > 0) {
          freshnessUpdates.freshnessInterrupts = 0;
        }
      }
    }

    // 簿记段（stepCount/consecutiveStuck 推导、F5 挂起标记、B4 blocked 原因、#170 锁内合并
    // mutator）已抽到 ./result-bookkeeping.js（#655，行为一字不改）——mutator 按引用闭包
    // guardUpdates，展开发生在锁内调用时，下方 F6-c 强制收口对 guardUpdates 的追加 mutate
    // 会被包含。编排顺序保持：新鲜度段（上方）→ prepareRecordBookkeeping → F6-c → updateMetadata。
    const bookkeeping = prepareRecordBookkeeping({
      wu, metadata, action, result, guardUpdates, freshnessUpdates,
      notices: { verifyBlocked, diffEmptyBlocked, contractArtifactBlocked },
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
    if (forceClosing && !verifyGuardRan
      && CODE_WORKTREE_TYPES.has(wu.type)
      && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
      const outcome = await runWuVerification(wu, metadata, metadata.worktreePath);
      if (outcome.failure) {
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'rejected',
          by: host.role.id,
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
          by: host.role.id,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: outcome.ran.join('；').slice(0, 300),
        });
        logger.info(`[AgentLoop] Force-close verify: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
      }
    }

    const recorded = await host.fileStore.updateMetadata(wuId, bookkeeping.mutator);
    if (!recorded) return; // WU 已被删除（terminate/GC 竞态）——簿记无处落，放弃本步收尾

    // P0 修复 6: trace 锚点 — 有 traceId 的 WU（频道消息链路）每步留一条可 grep 日志
    if (traceId) {
      logger.info(`[AgentLoop] Step recorded for ${wuId}`, { traceId, action, stepCount });
    }

    // §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零，之后每 3 步再提醒）
    if (noCommitNotice) {
      await this.postToDiscussionSpace(wuId, `任务 ${wuId} 连续 3 步无新提交，请注意及时 commit`);
    }

    // B3b-i: 自动验证连续失败 ≥3 次 → blocked 并频道说明（优先于 step limit / 状态迁移）
    if (verifyBlocked) {
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
      await this.postToDiscussionSpace(
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
    const outputGateBlocked = diffEmptyBlocked
      ? {
          failureType: 'diff_empty',
          message: `连续 ${guardUpdates.diffEmptyCount} 次报告完成却没有任何提交内容，任务已转 blocked，等待人类介入`,
        }
      : contractArtifactBlocked
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
      await this.postToDiscussionSpace(
        wuId,
        withBlockedCta(outputGateBlocked.message, String(blockReasonUpdates.blockReason ?? '')),
        wu,
      );
      return;
    }

    // B3b-i: 验证全绿 → 频道简报（跑了哪几条；仅当 COMPLETE 未被其他守卫拦截）
    if (verifyPassNotice && action === 'complete') {
      await this.postToDiscussionSpace(wuId, verifyPassNotice);
    }

    // Monitoring: step limit（review WU 用放宽阈值，见 REVIEW_STEP_LIMIT 注释；plan 无强制收口——额度守卫在 agentStep 前置，#471）
    if (stepLimit !== null && stepCount > stepLimit) {
      // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
      // #178（#63 决议 2）：状态迁移前 fencing，易主即静默退出
      if (wu.status === 'blocked' && !(await host.transitionIfHeld(wuId, 'active'))) return;
      if (!(await host.transitionIfHeld(wuId, 'in_review'))) return;
      await this.postToDiscussionSpace(wuId, '步骤数超限，强制提交审查');
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
      await this.postToDiscussionSpace(
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
        if (!skipResultPost && result.summary.trim().length > 0) await this.postToDiscussionSpace(wuId, result.summary);
        if (wu.status === 'blocked' && !(await host.transitionIfHeld(wuId, 'active'))) return;
        break;
      case 'complete':
        // 2026-07 PMO-flow UX（§6-3）：COMPLETE 完成汇报里程碑 —— meta 带 pmoId（可解析时）+ atHuman
        if (!skipResultPost && result.summary.trim().length > 0) {
          await this.postToDiscussionSpace(wuId, result.summary, wu);
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
          await this.postToDiscussionSpace(wuId, `需要输入: ${result.summary}`, wu,
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
        await this.postToDiscussionSpace(
          wuId,
          `『${host.role.name}』执行失败（第 ${consecutiveStuck} 次）：${(result.summary ?? '').slice(0, 200)}`,
        );
        break;
    }
  }

  /** §6-2 父 complete 守卫：未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
  private async listUnfinishedChildren(wuId: string): Promise<string[]> {
    const snapshots = await this.host.fileStore.getIndex();
    return snapshots
      .filter(s => s.parentId === wuId && !['done', 'closed'].includes(s.status))
      .map(s => s.id);
  }

  /** Post message to discussion space（经 wu-messenger → ChannelMessageService：eventBus + SSE，频道页实时可见）。
   *  milestoneWu 存在时按里程碑消息处理（2026-07 PMO-flow UX §6-3：meta 带 pmoId?/atHuman，普通 progress 不带）；
   *  2026-08 归因统一后解析链只读创建期持久化数据（metadata.pmoId / reqId），调用方直接传持久化 wu 本体，
   *  不再需要「持久化 + 本 step metadataUpdates」合并视图。
   *  extraMeta：#279 追加 meta（如 NEED_INPUT 的 options），合并于里程碑 meta 之上。 */
  async postToDiscussionSpace(workUnitId: string, content: string, milestoneWu?: WorkUnitData, extraMeta?: MessageMeta): Promise<void> {
    if (!content.trim()) return;
    const host = this.host;
    const wu = milestoneWu ?? await host.workUnitService.getById(workUnitId);
    if (!wu) return;

    // 绑定本 loop 的 fileStore（测试注入临时 store；生产与全局同目录），事件形状与全局 service 一致
    await postWuSystemMessage(wu, content, {
      agentName: host.role.name,
      fileStore: host.fileStore,
      ...(milestoneWu ? { milestone: true } : {}),
      ...(extraMeta ? { meta: extraMeta } : {}),
    });
  }
}
