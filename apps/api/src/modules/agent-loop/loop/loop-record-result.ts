/**
 * 结果记录段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * recordResult 步结果回写编排——B2 skipped 短路 → #178 fencing → 合并视图与收口守卫
 * → 回帖规则（./loop-record-reply.js）→ 簿记与原子写（./loop-record-persistence.js）
 * → 写后事件、通知与状态迁移（./loop-record-events.js）。
 * 附带 listUnfinishedChildren（§6-2 父 complete 守卫）与 postToDiscussionSpace
 * （频道系统消息唯一出口，经 deps seam 供 claim/step 段共用）。
 * ARCH-05：只组合 ResultRecorderDeps；fencing 归 WuLeaseTracker，原子写归 ExecutionJournal。
 */
import {
  mergedWuView, parseWuMetadata, postWuSystemMessage,
  type WorkUnitData, type WorkUnitMetadata,
} from '../../workunit/index.js';
import type { MessageMeta } from '../../channels/index.js';
import { runCompletionGuards } from '../completion-gates.js';
import { resolveExecutionCwd } from '../execution-cwd.js';
import type { StepResult, Target } from '../agent-loop.types.js';
import type { ResultRecorderDeps } from './loop-deps.js';
import { logger } from '@dommaker/studio-shared/node';
import { prepareResultReply } from './loop-record-reply.js';
import { persistResultBookkeeping } from './loop-record-persistence.js';
import { dispatchResultEvents } from './loop-record-events.js';
import { knowledgePorts, getKnowledgeExtractionEffects } from '../../knowledge/index.js';
import { CODE_WORKTREE_TYPES } from '../wu-verification.js';
import { getErrorMessage } from '../../../utils/errors.js';

export class ResultRecorder {
  constructor(private readonly deps: ResultRecorderDeps) {}

  /** Record result: monitoring checkpoints + state transitions (zero token) */
  async recordResult(target: Target, result: StepResult): Promise<void> {
    const deps = this.deps;
    // B2: 测试特征 WU 守卫已在 agentStep 自行关闭 WU 并留痕，无需任何簿记/状态迁移
    if (result.action === 'skipped') return;
    const wuId = target.workUnit.id;
    const wu = await deps.workUnits.getById(wuId);
    if (!wu) return;

    // #178（#63 决议 2）：fencing —— 步结果回写前比对 claimedAt 代际令牌。
    // 易主（超时释放后被他人认领 / 释放回池）→ 放弃回写、杀自身 CLI 进程组、
    // 停止心跳、静默退出（旧 holder 一字不再写，新 holder 的上下文不被污染）。
    if (!(await deps.lease.stillHolds(wuId))) {
      await deps.lease.handleLost(wuId, 'lost');
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
    const cwdDeps = { getWuById: (id: string) => deps.workUnits.getById(id) };
    const guards = await runCompletionGuards(
      { wu, wuId, metadata, action: result.action, roleId: deps.role.id },
      {
        resolveExecutionCwd: (w, m) => resolveExecutionCwd(w, m, cwdDeps),
        listUnfinishedChildren: id => this.listUnfinishedChildren(id),
      },
    );
    const { guardUpdates, notices } = guards;

    const reply = await prepareResultReply({
      wu, metadata, action: guards.action, result, guardUpdates,
    }, deps);
    const { action, skipResultPost, freshnessUpdates } = reply;

    const persisted = await persistResultBookkeeping({
      wu, metadata, action, result, guardUpdates, freshnessUpdates, notices,
    }, deps);
    if (!persisted.recorded) return; // WU 已被删除（terminate/GC 竞态）——簿记无处落，放弃本步收尾
    const { stepCount, consecutiveStuck, blockReasonUpdates, stepLimit } = persisted;

    // #715：所有学习产物统一使用最终 action、已持久化 StepRecord 和真实证据。
    if (persisted.snapshot && (result.executionResult || (action === 'complete' && result.learningConversation))) {
      const snapshot = persisted.snapshot;
      const latestMetadata = parseWuMetadata(snapshot.metadata);
      const stepRecord = [...(snapshot.stepRecords ?? [])].reverse()
        .find(record => record.assignmentId === result.assignmentId);
      const repo = latestMetadata.worktreeBaseRepo ?? latestMetadata.workspaceRoot ?? wu.projectPath ?? undefined;
      const scope = repo ? { kind: 'repo' as const, id: repo }
        : latestMetadata.pmoId ? { kind: 'project' as const, id: latestMetadata.pmoId }
          : { kind: 'role' as const, id: deps.role.id };
      const evidence = {
        workUnitId: wu.id,
        assignmentId: result.assignmentId,
        stepRecordId: stepRecord?.id,
        repo,
        commit: latestMetadata.mergeCommit ?? latestMetadata.lastCommitHash,
        transcriptRefs: stepRecord?.transcriptRefs ?? [],
        evidenceRefs: stepRecord?.artifacts ?? [],
        scope,
      };
      const outcome = {
        execution: result.executionResult?.success === false ? 'failed' as const : 'succeeded' as const,
        verification: stepRecord?.verification?.status ?? 'not-run' as const,
        delivery: CODE_WORKTREE_TYPES.has(wu.type) ? 'unmerged' as const : 'not-required' as const,
      };
      if (result.executionResult) {
        void knowledgePorts.produce.extractFromExecution({
          task: wu.scope ?? '',
          diff: result.executionResult.outputText ?? '',
          success: result.executionResult.success,
          duration: result.executionResult.totalDurationMs ?? 0,
          agentType: 'claude',
          consumedKnowledge: result.consumedKnowledge ?? [],
          learning: { ...evidence, extractionVersion: 'execution-1', revision: 1, outcome },
        }).catch(err => logger.warn(`[AgentLoop] extractFromExecution failed: ${getErrorMessage(err)}`));
      }
      if (action === 'complete' && result.learningConversation && result.assignmentId) {
        try {
          await getKnowledgeExtractionEffects(deps.fileStore).trigger(wu.id, result.assignmentId, {
            ...evidence,
            extractionVersion: 'conversation-1',
            revision: 1,
            outcome,
          });
        } catch (err) {
          // 完成主链不被提取存储故障阻断；启动补扫会从未消费 transcript 重建意图。
          logger.warn(`[AgentLoop] knowledge extraction effect enqueue failed: ${getErrorMessage(err)}`);
        }
      }
    }

    // P0 修复 6: trace 锚点 — 有 traceId 的 WU（频道消息链路）每步留一条可 grep 日志
    if (traceId) {
      logger.info(`[AgentLoop] Step recorded for ${wuId}`, { traceId, action, stepCount });
    }

    await dispatchResultEvents({
      wu,
      metadata,
      action,
      result,
      guardUpdates,
      blockReasonUpdates,
      stepCount,
      consecutiveStuck,
      skipResultPost,
      stepLimit,
      traceId,
      notices,
    }, {
      role: deps.role,
      lease: deps.lease,
      postToDiscussionSpace: (workUnitId, content, milestoneWu, extraMeta) =>
        this.postToDiscussionSpace(workUnitId, content, milestoneWu, extraMeta),
    });
  }

  /** §6-2 父 complete 守卫：未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
  private async listUnfinishedChildren(wuId: string): Promise<string[]> {
    const snapshots = await this.deps.fileStore.getIndex();
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
    const deps = this.deps;
    const wu = milestoneWu ?? await deps.workUnits.getById(workUnitId);
    if (!wu) return;

    // 绑定本 loop 的 fileStore（测试注入临时 store；生产与全局同目录），事件形状与全局 service 一致
    await postWuSystemMessage(wu, content, {
      agentName: deps.role.name,
      fileStore: deps.fileStore,
      ...(milestoneWu ? { milestone: true } : {}),
      ...(extraMeta ? { meta: extraMeta } : {}),
    });
  }
}
