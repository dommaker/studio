import { parseStreamEvents, extractCliSessionId, type StepRecordDetails } from '@dommaker/studio-shared';
import { estimateTokens } from '@dommaker/harness';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { writeStudioEvent, resolveStudioEventsFile } from '@dommaker/studio-shared';
import { getErrorMessage } from '../../../utils/errors.js';
import { emitExecutionStepEvent, emitExecutionStreamLine, emitExecutionStreamStepStart } from '../execution-step-events.js';
import { harvestCompletionMetadata } from '../completion-harvest.js';
import type { StepResult, Target } from '../agent-loop.types.js';
import { parseAgentOutput, stepActivityFromEvents } from '../agent-loop-parsers.js';
import {
  resolveRealUsage, writeWorkunitTokenEvent,
  resolveToolTraceFile, writeToolCallEvents, type RealUsage,
} from '../agent-loop-events.js';
import {
  composeStepPrompt,
  type ComposedStepPrompt,
  type PromptComposerDeps,
} from '../prompt-composer.js';
import { runStepRetry, resetUnestablishedSessionBookkeeping } from '../step-retry-policy.js';
import { isContextOverflowError } from '../context-overflow.js';
import { appendTranscriptStep, transcriptPath, transcriptStepRef } from '../../transcripts/index.js';
import type { StepDeps } from './loop-deps.js';
import { logger } from '@dommaker/studio-shared/node';

/** #171（#54 决议 A1，数值来自 #68 实测）：三层超时 ——
 *  步墙钟 1800s 仅作兜底天花板（健康步时长 p99=693s × 2.6 安全系数；
 *  旧 120s 固定墙钟连健康 p90=128s 都不到，上线以来大量健康步被误杀）；
 *  主防线 = 静默看门狗：判据 = 距最后一次输出间隔（步内最大静默 p99=215s / 极值 305s，
 *  均来自长 Bash 调用），300s warn（落 workunit:step_silence 事件）/ 600s 杀进程组；
 *  预算语义归 maxTurns=50 + token 记账，不由超时承担。warn 探活为 #54 留的迭代方向，本期不做。 */
const STEP_WALL_CLOCK_MS = 1_800_000;
const STEP_SILENCE_WARN_MS = 300_000;
const STEP_SILENCE_KILL_MS = 600_000;

export interface StepExecutionInput {
  target: Target;
  wu: WorkUnitData;
  assignmentId: string;
  metadata: WorkUnitMetadata;
  metadataUpdates: Partial<WorkUnitMetadata>;
  traceId?: string;
  channelVersion?: StepResult['channelVersion'];
  workspaceRoot: string | null;
  taskProvider: AgentTask['provider'];
  resumeSessionId: string | null;
  newSessionId: string | null;
  sessionsUsed: number;
  composed: ComposedStepPrompt;
  composeDeps: PromptComposerDeps;
}

export interface StepExecutionDeps {
  step: StepDeps;
  setCurrentExecutionId(executionId: string | null): void;
  recordExecutionOutcome: (wu: WorkUnitData, result: ExecutionResult, consumedKnowledge: string[]) => Promise<void>;
  recordOutcomeEvent: (
    wu: WorkUnitData,
    success: boolean,
    details: string,
    errorType: string | undefined,
    consumedKnowledge: string[],
  ) => void;
}

/** 构造并执行 AgentTask，处理重试、执行簿记、事件与完成收割。 */
export async function executeAgentStep(
  input: StepExecutionInput,
  deps: StepExecutionDeps,
): Promise<StepResult> {
  const {
    target, wu, metadata, metadataUpdates, traceId, channelVersion, workspaceRoot,
    taskProvider, resumeSessionId, newSessionId, sessionsUsed, composed, composeDeps,
  } = input;
  const { step } = deps;
  const { prompt, pendingReplies, knowledgeContext, skillMatched, injectedKnowledgeIds } = composed;
  let activeComposed = composed;
  let assignmentId = input.assignmentId;

  // 本步最终实际会话形态（续用降级重试后会被改写：换新号 + resumed=false）
  let effectiveSessionId: string | null = resumeSessionId ?? newSessionId;
  let sessionResumed = resumeSessionId !== null;
  let recoveredFrom: 'full' | 'delta' | undefined;
  const executionId = `${wu.id}-${Date.now()}`;
  // 本步步号（与 recordResult 的 stepCount+1 同口径）——Layer A 执行步事件与 Layer B 步内流式共用
  const stepNo = (metadata.stepCount ?? 0) + 1;
  const task: AgentTask = {
    id: wu.id,
    executionId,
    // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
    // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
    provider: taskProvider,
    prompt,
    parameters: {
      // 续用：sessionId = CLI 真实会话号（#639：claude 为档案 UUID，kimi/codex/opencode
      // 为档案 cliSessionId）+ sessionResume → cli-adapter 按 provider 换 id 形态续用
      // （claude --resume <id>；kimi/opencode --session <id>；codex exec resume <id>）。
      // 新建：仅 claude 把新 sessionId 传给 CLI（--session-id 建会话 —— 不建则后续 --resume
      // 找不到会话，2.1.80 实测报 "No conversation found"）；kimi/codex/opencode 的 session
      // 参数均续用语义（实测未知 id 报 Session not found）→ 新建不传，CLI 自建会话。
      sessionId: resumeSessionId ?? (newSessionId && taskProvider === 'claude' ? newSessionId : undefined),
      ...(resumeSessionId ? { sessionResume: true } : {}),
      maxTurns: 50,
      knowledgeContext: knowledgeContext || undefined,
      agentRole: 'executor',
      workUnitId: wu.id,
      // #174: transcript 归档路径随 task 下发，runner 发 session:start/end 事件时并入 payload
      // （路径规则唯一权威在 #97 归档器，含测试环境改写，勿在此复制规则）
      transcriptPath: transcriptPath(wu.id),
      agentProfileId: step.role.id,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      extraEnv: {
        STUDIO_WORKUNIT_ID: wu.id,
        STUDIO_CHANNEL_ID: wu.channelId ?? '',
        STUDIO_TRACE_ID: traceId ?? '',
      },
    },
    timeoutMs: STEP_WALL_CLOCK_MS,
    // #171（#54 决议 A1）：静默看门狗 300s warn / 600s 杀进程组（杀法在 execSh killProcessGroup）。
    silenceWarnMs: STEP_SILENCE_WARN_MS,
    silenceKillMs: STEP_SILENCE_KILL_MS,
    onSilenceWarn: (silentMs) => {
      logger.warn('[AgentLoop] Step silence warn — no output beyond threshold', {
        workUnitId: wu.id, executionId, step: stepNo, silentMs, warnThresholdMs: STEP_SILENCE_WARN_MS, traceId,
      });
      // warn 层负责「感知」：落事件流，供监控面板/告警管线消费（#54 决议 2）
      void writeStudioEvent('workunit:step_silence', {
        workUnitId: wu.id, executionId, step: stepNo, silentMs, warnThresholdMs: STEP_SILENCE_WARN_MS,
      }, { source: 'agent-loop' }).catch(() => { /* fire-and-forget */ });
    },
    // Layer B（WU 过程可视化）：步内 stream-json 行级透传 → SSE 实时过程。
    // fire-and-forget；仅 LocalExecutor 同进程有效。
    onStreamLine: (line) => {
      void emitExecutionStreamLine({ workUnitId: wu.id, channelId: wu.channelId, executionId, step: stepNo, line }).catch(() => {});
    },
  };

  const assignmentIsCurrent = async (): Promise<boolean> => {
    const current = (await step.fileStore.getIndex({ id: wu.id }))[0];
    const assignment = current?.assignments?.find(a => a.id === assignmentId);
    return current?.currentAssignmentId === assignmentId
      && Boolean(assignment && ['queued', 'running'].includes(assignment.status));
  };
  const staleResult = (): StepResult => ({
    action: 'failed', assignmentId, summary: 'Assignment 已换代，丢弃迟到执行产物',
  });

  // M2 成本红线度量 + B6 真实 token 记账（2026-08-03 token-burn issue P1-2）：
  // 成功与失败执行都记 workunit:tokens（失败照样烧 token）。fire-and-forget，绝不影响任务流程。
  const recordTokenEvent = async (res: ExecutionResult): Promise<RealUsage | null> => {
    if (!(await assignmentIsCurrent())) return null;
    // #134: usage 解析按 provider 分流（opencode/codex 事件形态与 claude 不同）
    const real = resolveRealUsage(res, taskProvider);
    void writeWorkunitTokenEvent(resolveStudioEventsFile(), {
      workUnitId: wu.id,
      channelId: wu.channelId,
      assignmentId,
      executionId: task.executionId,
      injectedTokens: estimateTokens(activeComposed.knowledgeContext),
      executionTokens: real ? real.inputTokens + real.outputTokens : null,
      // D16/B6: 缓存命中与真实账单数据源（CLI 回报 usage 时才有；未回报则缺省不编造）
      ...(real ? {
        inputTokens: real.inputTokens,
        outputTokens: real.outputTokens,
        cacheReadTokens: real.cacheReadTokens,
        cacheCreationTokens: real.cacheCreationTokens,
        billedTokens: real.billedTokens,
        ...(real.costUsd ? { costUsd: real.costUsd } : {}),
        ...(real.numTurns ? { numTurns: real.numTurns } : {}),
      } : {}),
      // B6: 触发器来源落盘（按触发器聚合的输入）
      ...(typeof metadata.triggerId === 'string' && metadata.triggerId ? { triggerId: metadata.triggerId } : {}),
      // #134: provider 落盘（#120 按 provider 分桶的数据源）
      provider: taskProvider,
    }).catch(() => {});
    if (real) await step.executionJournal.recordTokenUsage(wu.id, assignmentId, real.billedTokens);
    return real;
  };

  // #172（#60 决策 Q1）：失败步也落 execution_step 事件（status='failed' + 错误字段）——
  // 此前失败分支提前 return 到不了成功路径的发射点，失败步在事件流中完全不可查。
  // 读取调用时的 effectiveSessionId/sessionResumed 当前值（重试降级后可能被改写）。
  // fire-and-forget，与成功路径发射同形态，绝不影响失败处理流程。
  const emitFailedStep = async (action: string, detail: string, res?: ExecutionResult) => {
    if (!(await assignmentIsCurrent())) return;
    // #453: 失败路径保持按原文解析（票内决议）——失败步仅此一个消费点，解析一次；
    // 成功路径的解析产物复用不延伸到这里（失败步与成功步互斥，无重复解析可省）。
    const failedRaw = res?.rawOutput;
    const failedCliSessionId = failedRaw ? extractCliSessionId(taskProvider, failedRaw) : null;
    void emitExecutionStepEvent({
      workUnitId: wu.id,
      channelId: wu.channelId,
      assignmentId,
      executionId: task.executionId,
      sessionId: effectiveSessionId ?? undefined,
      // #639: 失败步同样落 CLI 真实会话号（流内有才带，不编造）
      ...(failedCliSessionId ? { cliSessionId: failedCliSessionId } : {}),
      sessionResumed,
      context: activeComposed.context,
      contextOverflow: isContextOverflowError(detail),
      recoveredFrom,
      step: stepNo,
      action,
      events: failedRaw && failedRaw.trim().length > 0 ? parseStreamEvents(failedRaw) : [],
      skills: skillMatched,
      status: 'failed',
      errorType: 'execution_failed',
      errorDetail: detail,
    }).catch(() => {});
  };

  try {
    // Layer B: step 开始信号（CLI 首行到达前抽屉即有反馈）
    void emitExecutionStreamStepStart({ workUnitId: wu.id, channelId: wu.channelId, executionId, step: stepNo }).catch(() => {});
    // #178（#63 决议 2）：fencing 易主时按 executionId 杀自身 CLI 进程组（finally 清除）
    deps.setCurrentExecutionId(executionId);
    // §9.6: 经 Executor 接口执行（P0 恒为 LocalExecutor → agentRunner.executeLightweight）
    let result: ExecutionResult = await step.executor.execute(task);
    if (!(await assignmentIsCurrent())) return staleResult();

    // W-3 接线：runner 失败时返回 { success:false } 而不抛错、且无 outputText ——
    // 直接落入 parseAgentOutput 会得到默认 progress（空 summary），导致 consecutiveStuck
    // 被清零、每 3s 重试、往频道发空消息。显式失败分支：action='failed'，由 recordResult
    // 记 consecutiveStuck + errorType/errorDetail，并发「执行失败（第 N 次）」系统消息
    // （#175/#55 决议）；连续 3 次走 blocked 里程碑路径。
    // 不带 channelVersion —— 失败消息是系统通知不是结果回帖，不参与 §4.2 新鲜度判定。
    if (result.success === false) {
      const failResult = (detail: string) => ({
        action: 'failed' as const,
        assignmentId,
        summary: `CLI 执行失败: ${detail}`,
        metadataUpdates: {
          ...metadataUpdates,
          errorType: 'execution_failed',
          errorDetail: detail,
          errorAt: new Date().toISOString(),
        },
      });
      const detail = (result.error ?? '未知错误').slice(0, 500);
      logger.error(`[AgentLoop] agentStep execution failed for ${wu.id}: ${detail}`, { traceId });
      // B6: 失败执行同样记账（CLI 已跑的轮次照样烧了 token，runner error 路径透出 usage）
      await recordTokenEvent(result);
      // #543: #94 续用丢失降级与 #96 上下文溢出两段孪生重试骨架（配额判定 → 改参 →
      // 重算 prompt → 再执行 → 成败分叉 → 簿记回写）收编到 ./step-retry-policy.js ——
      // 本处只保留编排：注入 executor/prompt 重算/记账/失败事件 deps，按 outcome 分流。
      // 非续用类错误（超时/业务失败）与 catch 分支（spawn 异常）不触发；每步至多烧一次重试。
      const retryOutcome = await runStepRetry(
        { wu, metadata, provider: taskProvider, task, firstResult: result, detail, sessionsUsed, resumeSessionId, metadataUpdates, traceId },
        {
          execute: (t) => step.executor.execute(t),
          recomposePrompt: async ({ isNewSession }) => {
            // #714：保留导致替换的溢出样本；恢复结果再以 recoveredFrom 归因到来源模式。
            if (isContextOverflowError(detail)) await emitFailedStep('failed', detail, result);
            recoveredFrom = composed.context.mode;
            // 两种重试都已替换真实 CLI session，禁止携带旧游标；prompt 与稳定前缀一起换新。
            activeComposed = await composeStepPrompt(
              { wu, metadata, newReplies: target.newReplies?.map(r => r.content), isNewSession },
              composeDeps,
            );
            task.parameters!.knowledgeContext = activeComposed.knowledgeContext || undefined;
            return activeComposed.prompt;
          },
          recordTokenEvent,
          recordFailureOutcome: (d) => deps.recordOutcomeEvent(wu, false, d, 'execution_failed', injectedKnowledgeIds),
          emitFailedStep,
          replaceSession: async (sessionId) => {
            const replaced = await step.executionJournal.replaceForSession(wu.id, assignmentId, sessionId);
            const nextAssignmentId = replaced?.currentAssignmentId;
            if (!nextAssignmentId) throw new Error('Assignment changed before session replacement');
            assignmentId = nextAssignmentId;
            task.executionId = `${executionId}-${nextAssignmentId}`;
            deps.setCurrentExecutionId(task.executionId);
            step.onAssignment(assignmentId, wu);
          },
        },
      );
      if (retryOutcome.kind === 'terminal') return { ...retryOutcome.result, assignmentId };
      if (retryOutcome.kind === 'retried') {
        // 重试成功：走正常成功路径；换新号（簿记已由策略写入 metadataUpdates）
        result = retryOutcome.result;
        effectiveSessionId = retryOutcome.sessionId;
        sessionResumed = false;
      } else {
        // 非重试类失败（no-retry）：首 step 失败会话未必已建立，重置避免下步 --resume
        // 一个从未建立的会话
        if (newSessionId) resetUnestablishedSessionBookkeeping(metadataUpdates);
        deps.recordOutcomeEvent(wu, false, detail, 'execution_failed', injectedKnowledgeIds);
        emitFailedStep('failed', detail, result);
        return failResult(detail);
      }
    }
    if (!(await assignmentIsCurrent())) return staleResult();

    // #94: sessionResumes 只计「实际续用成功」的步（续用尝试但降级/失败的步不计，防计数失真）
    if (sessionResumed) {
      metadataUpdates.sessionResumes = (metadata.sessionResumes ?? 0) + 1;
    }

    const stepResult = parseAgentOutput(result.outputText ?? '');

    // 执行成功 → 清除上一轮失败标记（undefined 在 JSON 序列化时丢弃）
    metadataUpdates.errorType = undefined;
    metadataUpdates.errorDetail = undefined;
    metadataUpdates.errorAt = undefined;

    // M2 成本红线度量 + B6 真实记账: 每次 CLI 执行完成记一条 workunit:tokens 事件
    // （注入估算 estimateTokens 口径 vs 注入红线 INJECT_TOKEN_BUDGET；执行 tokens 取 CLI 真实 usage，未回报记 null 不编造）。
    const realUsage = await recordTokenEvent(result);

    // wireup④ token 预算数据源: 本次真实消耗（billed 口径，含 cache）累加进
    // metadata._cumulativeTokens，随 metadataUpdates 由 recordResult 单次原子写入。
    // CLI 未回报 usage（realUsage=null）按 0 累加——即保持既有累计值不变。
    metadataUpdates._cumulativeTokens = (metadata._cumulativeTokens ?? 0) + (realUsage?.billedTokens ?? 0);

    // T-1.1: Record tool:call events for PatternMiner data source
    // D18: 写入统一事件文件（~/.studio/logs/studio-events.jsonl）
    // R2-fix: outputText 是 extractResult 后的纯文本（不含 stream-json 事件行），
    // 必须优先取 rawOutput（原始 stdout）——否则 parseStreamEvents 恒产 0 条。
    // #453: 成功路径全量解析一次（3→1）——tool:call 落盘与 execution_step 提炼共享
    // 同一份 StreamEvent[]；usage 记账（recordTokenEvent）保持吃原文（claude 主路径走
    // 末行 parseSessionMetrics 已便宜；opencode/codex 事件形态不同，改 shared 公开 API
    // 外溢不划算，票内 triage 决议）。
    const toolTraceSource = result.rawOutput ?? result.outputText;
    const stepEvents = toolTraceSource ? parseStreamEvents(toolTraceSource) : [];
    // #639: CLI 真实会话号落档（与档案会话号 UUID 并存，术语见 agents/CONTEXT.md
    // 「会话术语」）——下一步 kimi/codex/opencode 按它点名续用；claude 仅观测落档
    // （续用仍走 sessionId，行为零变化）。读不到不编造（extractCliSessionId → null 不动档案）。
    const stepCliSessionId = toolTraceSource ? extractCliSessionId(taskProvider, toolTraceSource) : null;
    if (stepCliSessionId) metadataUpdates.cliSessionId = stepCliSessionId;
    if (toolTraceSource) {
      try {
        // #602 D4：caller 落真实角色 id（(c) 链路按 caller 匹配 .agents/roles/<id>）
        writeToolCallEvents(stepEvents, resolveToolTraceFile(), { caller: step.role.id });
      } catch { /* non-blocking */ }
    }

    // #712：步骤写盘完成后再返回，transcriptRecorded 只报告真实落盘结果。
    // 写失败不阻断任务流程；StepRecord 保留预期引用，后续对账会把残缺段标为 failed。
    let transcriptRecorded = false;
    if (toolTraceSource) {
      // 解析/记账等 await 之后立即复核，缩小换代后迟到原文的写入窗。
      if (!(await assignmentIsCurrent())) return staleResult();
      try {
        await appendTranscriptStep({
          workUnitId: wu.id,
          assignmentId,
          sessionId: effectiveSessionId ?? undefined,
          step: stepNo,
          action: stepResult.action,
          rawOutput: toolTraceSource,
        });
        transcriptRecorded = true;
      } catch (err) {
        logger.warn('[AgentLoop] transcript append failed (non-blocking)', { workUnitId: wu.id, assignmentId, error: String(err) });
      }
    }

    // WU 过程可视化：执行步事件（本步思考/工具调用/skill 注入/用量 → 事件流落盘 + SSE，
    // WU 详情抽屉消费；不进频道、不写 metadata 防膨胀）。fire-and-forget。
    void emitExecutionStepEvent({
      workUnitId: wu.id,
      channelId: wu.channelId,
      assignmentId,
      executionId: task.executionId,
      sessionId: effectiveSessionId ?? undefined,
      // #639: 本步 CLI 真实会话号（与该步 transcript rawOutput 中的编号一致，可对照）
      ...(stepCliSessionId ? { cliSessionId: stepCliSessionId } : {}),
      // #94: 本步最终实际的续用形态（续用降级重试后 = false）
      sessionResumed,
      context: activeComposed.context,
      recoveredFrom,
      step: stepNo,
      action: stepResult.action,
      // #453: 复用上方统一解析的 stepEvents（与 tool:call 落盘共享同一份解析产物）
      events: stepEvents,
      skills: skillMatched,
    }).catch(() => {});

    // GAP-6: recordOutcome + extractFromExecution (non-blocking)
    // R1: 携带本次注入的知识条目 id，反馈环才有数据
    deps.recordExecutionOutcome(wu, result, injectedKnowledgeIds).catch(() => {});

    // #716：只暂存完成事实；真正输入由 Effect 从 committed transcript 恢复读取，
    // 成功由 Effect/Receipt 表达，不再提前写 knowledgeExtractedAt 哨兵。
    let learningConversation: { role: string; content: string }[] | undefined;
    if (stepResult.action === 'complete') {
      learningConversation = [
        { role: 'user', content: wu.scope ?? '' },
        ...pendingReplies.map(content => ({ role: 'user', content })),
        { role: 'assistant', content: stepResult.summary },
      ];
    }

    // #542：per-WU-type COMPLETE 收割改注册表（completion-harvest.ts）——
    // review→reviewReport / analysis|plan→analysisTasks+analysisFog+opportunities /
    // decision→decisionSuggestion / spec→specTasks。新 type 收割 = 注册表加一行；
    // 解析无获不落档、单收割器抛错仅跳过，均不阻断完成（语义同原各分支）。
    if (stepResult.action === 'complete') {
      Object.assign(metadataUpdates, harvestCompletionMetadata(result.outputText ?? '', {
        wuId: wu.id, wuType: wu.type, metadata,
      }));
    }

    const activity = stepActivityFromEvents(stepEvents);
    const reported = stepResult.stepRecord;
    const commands = new Map([
      ...(reported?.commands ?? []),
      ...(activity.commands ?? []),
    ].map(command => [`${command.command}\0${command.status}`, command]));
    const stepRecord: StepRecordDetails = {
      ...reported,
      modifiedFiles: [...new Set([...(activity.modifiedFiles ?? []), ...(reported?.modifiedFiles ?? [])])],
      commands: [...commands.values()],
      transcriptRefs: [...new Set([
        ...(reported?.transcriptRefs ?? []),
        ...(toolTraceSource ? [transcriptStepRef(wu.id, stepNo)] : []),
      ])],
    };

    return {
      ...stepResult,
      assignmentId,
      transcriptRecorded,
      stepRecord,
      learningConversation,
      executionResult: result,
      consumedKnowledge: injectedKnowledgeIds,
      contextCursor: activeComposed.contextCursor,
      context: activeComposed.context,
      metadataUpdates,
      channelVersion,
    };
  } catch (err) {
    // W-3 fix: executeLightweight 失败返回 { success:false } 不抛错 —— 已在上方
    // success===false 显式分支接线（consecutiveStuck → blocked）；本 catch 只覆盖
    // 真正抛出的异常（如 spawn 失败），保持 need_input 语义。
    // 首 step 抛异常：会话未建立，重置避免下步 --resume 空 id
    if (newSessionId) resetUnestablishedSessionBookkeeping(metadataUpdates);
    const message = getErrorMessage(err);
    logger.error(`[AgentLoop] agentStep execute failed: ${message}`, { traceId });
    deps.recordOutcomeEvent(wu, false, message, 'execution_failed', injectedKnowledgeIds);
    // #172: spawn 异常等抛出路径的失败步同样落 execution_step（status=failed）
    emitFailedStep('need_input', message);
    // AC-8.7 远程节点不可达分支已随 RemoteExecutor 一并删除（远程方向放弃，bdaf0dd3）。
    return {
      action: 'need_input' as const, // increments consecutiveStuck
      assignmentId,
      summary: `Agent execution failed: ${message}`,
      metadataUpdates,
    };
  } finally {
    // #178: 步结束（含被杀/异常）清除当前 executionId，fencing 杀进程组只针对在飞步
    deps.setCurrentExecutionId(null);
  }
}
