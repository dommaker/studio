/**
 * 步执行段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * agentStep 单步执行编排——入口守卫链（./step-guards.js）→ traceId 贯穿 / §4.2 频道版本
 * 锚点 → worktree 解析（./loop-step-worktree.js）→ 会话续用判定与签发（./loop-step-session.js）
 * → prompt 组装（./loop-step-prompt.js）→ Executor 执行与簿记（./loop-step-execution.js）。
 * 附带 outcome 落账两件套（recordExecutionOutcome / recordOutcomeEvent，#90 单一正本）。
 * ARCH-05：输入为显式 StepContext，执行 id 由本类独占，依赖限 StepDeps。
 */
import type { ExecutionResult } from '@dommaker/studio-agent';
import { parseWuMetadata, type WorkUnitData, type WorkUnitMetadata } from '../../workunit/index.js';
import { resolveStudioEventsFile } from '@dommaker/studio-shared';
import { knowledgePorts } from '../../knowledge/index.js';
import { runStepGuards } from '../step-guards.js';
import type { StepContext, StepResult } from '../agent-loop.types.js';
import type { StepDeps } from './loop-deps.js';
import { resolveStepWorktree } from './loop-step-worktree.js';
import { issueStepSession, resolveStepSession } from './loop-step-session.js';
import { composeAgentStepPrompt } from './loop-step-prompt.js';
import { executeAgentStep } from './loop-step-execution.js';

export class StepRunner {
  private currentExecutionId: string | null = null;

  constructor(private readonly deps: StepDeps) {}

  getCurrentExecutionId(): string | null {
    return this.currentExecutionId;
  }

  /** Execute one step via Agent process (Agent's token) */
  async agentStep(context: StepContext): Promise<StepResult> {
    const deps = this.deps;
    const target = context;
    const wu = target.workUnit;
    const metadata = parseWuMetadata(wu.metadata);

    // 入口守卫链（#541，对称出口侧 completion-gates）：B2 测试特征 WU / #585 需求+AC /
    // C3 日 token 预算 / #162 WU 级 tokenBudget / #471 plan 步数额度五段「该不该跑这一步」
    // 前置判定抽到 ./step-guards.js（顺序即优先级，首个命中短路）。命中即返回（skipped/need_input），放行继续。
    const guardOutcome = await runStepGuards({ wu, metadata }, {
      updateWuMetadata: (wuId, m) => deps.workUnits.update(wuId, { metadata: m }),
      closeWu: wuId => deps.workUnits.transitionStatus(wuId, 'closed', { id: context.instance?.id ?? deps.role.id, type: 'agent' }),
      postNotice: (wuId, text) => deps.discussion.postToDiscussionSpace(wuId, text),
      eventsFilePath: resolveStudioEventsFile,
    });
    if (guardOutcome.result) return guardOutcome.result;

    // P0 修复 6: traceId 贯穿 — 频道消息 → WU metadata → 执行参数（extraEnv）与日志行
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // §4.2 发言层新鲜度检查：step 开始记录频道版本（recordResult 回帖前比对）。
    // 读取失败按 undefined 处理 —— 跳过检查直接发帖，绝不阻断执行。
    const channelVersion = wu.channelId
      ? await deps.fileStore.getChannelVersion(wu.channelId).catch(() => undefined)
      : undefined;

    // 本 step metadata 增量（agentStep 落盘、recordResult 原子写）。worktree 解析 / 会话签发 /
    // prompt 组装消费的 hint 清除都合并进这里。
    const metadataUpdates: Partial<WorkUnitMetadata> = {};

    const worktree = await resolveStepWorktree({ wu, metadata, metadataUpdates, traceId }, deps);
    if (worktree.failure) return worktree.failure;
    const { taskProvider, resumeSessionId } = resolveStepSession(
      { wu, metadata, workspaceRoot: worktree.workspaceRoot, traceId },
      deps,
    );
    const { composed, composeDeps } = await composeAgentStepPrompt(
      { target, wu, metadata, resumeSessionId, metadataUpdates },
      deps,
    );
    const session = issueStepSession({ wu, metadata, resumeSessionId, metadataUpdates });
    if (session.failure) return session.failure;

    const assignmentSnapshot = await deps.executionJournal.beginStep({
      wu,
      provider: taskProvider,
      sessionId: resumeSessionId ?? session.newSessionId ?? undefined,
      worktreePath: metadataUpdates.worktreePath ?? metadata.worktreePath,
      worktreeBranch: metadataUpdates.worktreeBranch ?? metadata.worktreeBranch,
    });
    const assignmentId = assignmentSnapshot?.currentAssignmentId;
    if (!assignmentId) return { action: 'failed', summary: '执行轮次已失效，放弃本步写回' };
    deps.onAssignment(assignmentId, wu);

    return executeAgentStep({
      target,
      wu,
      assignmentId,
      metadata,
      metadataUpdates,
      traceId,
      channelVersion,
      workspaceRoot: worktree.workspaceRoot,
      taskProvider,
      resumeSessionId,
      newSessionId: session.newSessionId,
      sessionsUsed: session.sessionsUsed,
      composed,
      composeDeps,
    }, {
      step: deps,
      setCurrentExecutionId: executionId => { this.currentExecutionId = executionId; },
      recordExecutionOutcome: (wu, result, consumedKnowledge) =>
        this.recordExecutionOutcome(wu, result, consumedKnowledge),
      recordOutcomeEvent: (wu, success, details, errorType, consumedKnowledge) =>
        this.recordOutcomeEvent(wu, success, details, errorType, consumedKnowledge),
    });
  }

  /** outcome 事件即时落账；#715 起学习提取由 recordResult 在 StepRecord 持久化后统一触发。 */
  private async recordExecutionOutcome(wu: WorkUnitData, result: ExecutionResult, consumedKnowledge: string[] = []): Promise<void> {
    this.recordOutcomeEvent(wu, result.success, result.outputText ?? '', undefined, consumedKnowledge);
  }

  /** #90: knowledge:outcome 事件单一正本 —— success/failure 统一经此落盘，避免两套漂移。
   *  errorType 仅失败步携带（success 时 undefined，JSON.stringify 丢弃）。fire-and-forget。 */
  private recordOutcomeEvent(wu: WorkUnitData, success: boolean, details: string, errorType: string | undefined, consumedKnowledge: string[]): void {
    void knowledgePorts.track.recordOutcome({
      executionId: wu.id,
      agentType: 'claude',
      consumedKnowledge,
      success,
      details: details.slice(0, 500),
      errorType,
      timestamp: new Date().toISOString(),
    }).catch(() => { /* Non-blocking */ });
  }
}
