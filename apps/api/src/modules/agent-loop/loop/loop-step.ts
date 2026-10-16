/**
 * 步执行段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * agentStep 单步执行编排——入口守卫链（./step-guards.js）→ traceId 贯穿 / §4.2 频道版本
 * 锚点 → worktree 解析与 PMO 分支基线（B3a/B3b-i/PMO-b，目录解析规则在 ./execution-cwd.js）
 * → 会话续用判定（#94/#637/#639，./session-resume.js）→ prompt 组装（./prompt-composer.js）
 * → 会话签发（B5 每 WU 会话数上限）→ Executor 执行 → 失败显式分支与孪生重试骨架
 * （./step-retry-policy.js）→ 成功路径簿记（token 记账 / tool:call 落盘 / transcript 归档 /
 * 执行步事件 / R3 会话提取 / #542 COMPLETE 收割）。
 * 附带 outcome 落账两件套（recordExecutionOutcome / recordOutcomeEvent，#90 单一正本）。
 * 全部共享状态经 AgentLoopHost 读写；本类零自有状态。
 */
import { parseStreamEvents, extractCliSessionId } from '@dommaker/studio-shared';
import { estimateTokens } from '@dommaker/harness';
import { randomUUID } from 'crypto';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { ensureWuWorktree, ensureBranchExists, getDefaultBranch } from '@dommaker/studio-agent';
import { parseWuMetadata, type WorkUnitData, type WorkUnitMetadata } from '../../workunit/index.js';
import { resolvePmoBranchForWU } from '../../requirements/index.js';
import { writeStudioEvent, resolveStudioEventsFile } from '@dommaker/studio-shared';
import { getErrorMessage } from '../../../utils/errors.js';
import { emitExecutionStepEvent, emitExecutionStreamLine, emitExecutionStreamStepStart } from '../execution-step-events.js';
import { knowledgeService } from '../../knowledge/index.js';
import { CODE_WORKTREE_TYPES } from '../wu-verification.js';
import { runStepGuards } from '../step-guards.js';
import { harvestCompletionMetadata } from '../completion-harvest.js';
import type { StepResult, Target } from '../agent-loop.types.js';
import {
  isGitRepoRoot, resolveWorktreesDir, parseAgentOutput,
} from '../agent-loop-parsers.js';
import {
  resolveRealUsage, writeWorkunitTokenEvent,
  resolveToolTraceFile, writeToolCallEvents, type RealUsage,
} from '../agent-loop-events.js';
import { composeStepPrompt } from '../prompt-composer.js';
import { shouldResumeSession } from '../session-resume.js';
import { runStepRetry, resetUnestablishedSessionBookkeeping, MAX_SESSIONS_PER_WU } from '../step-retry-policy.js';
import { appendTranscriptStep, transcriptPath } from '../../transcripts/index.js';
import { resolveExecutionWorkspaceRoot, resolveParentWorktreePath } from '../execution-cwd.js';
import type { AgentLoopHost } from './loop-host.js';
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

// B5 每 WU 会话数上限 MAX_SESSIONS_PER_WU：#543 迁到 ./step-retry-policy.js（重试配额判定
// 真属主，语义注释随迁），本段新建会话签发（下方 sessionsUsed 检查）经 import 复用同一常量。

// §10 P0 注入总预算（注入红线）随 prompt 组装段一并迁到 ./prompt-composer.js（2026-08 工单 05）

export class StepRunner {
  constructor(private readonly host: AgentLoopHost) {}

  /** Execute one step via Agent process (Agent's token) */
  async agentStep(target: Target): Promise<StepResult> {
    const host = this.host;
    const wu = target.workUnit;
    const metadata = parseWuMetadata(wu.metadata);

    // 入口守卫链（#541，对称出口侧 completion-gates）：B2 测试特征 WU / #585 需求+AC /
    // C3 日 token 预算 / #162 WU 级 tokenBudget / #471 plan 步数额度五段「该不该跑这一步」
    // 前置判定抽到 ./step-guards.js（顺序即优先级，首个命中短路）。命中即返回（skipped/need_input），放行继续。
    const guardOutcome = await runStepGuards({ wu, metadata }, {
      updateWuMetadata: (wuId, m) => host.workUnitService.update(wuId, { metadata: m }),
      closeWu: wuId => host.workUnitService.transitionStatus(wuId, 'closed', { id: host.instance?.id ?? host.role.id, type: 'agent' }),
      postNotice: (wuId, text) => host.postToDiscussionSpace(wuId, text),
      eventsFilePath: resolveStudioEventsFile,
    });
    if (guardOutcome.result) return guardOutcome.result;

    // P0 修复 6: traceId 贯穿 — 频道消息 → WU metadata → 执行参数（extraEnv）与日志行
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // §4.2 发言层新鲜度检查：step 开始记录频道版本（recordResult 回帖前比对）。
    // 读取失败按 undefined 处理 —— 跳过检查直接发帖，绝不阻断执行。
    const channelVersion = wu.channelId
      ? await host.fileStore.getChannelVersion(wu.channelId).catch(() => undefined)
      : undefined;

    // 本 step metadata 增量（agentStep 落盘、recordResult 原子写）。worktree 解析 / 会话签发 /
    // prompt 组装消费的 hint 清除都合并进这里。
    const metadataUpdates: Partial<WorkUnitMetadata> = {};

    // F6 → B3a: WorkUnit 绑定工程 → 解析执行根目录，经 parameters.workspaceRoot
    // 传给 agent-runner（resolveWorkspace Priority 1：直接以该目录为 cwd）。
    // #481：唯一来源是 metadata.workspaceRoot（B3a 归属链：Requirement→PMO gitRepo /
    // 文件引用 / 频道默认工程 / 人工回复绑定）；wu.workspaceId 不再参与 cwd 决策。
    // 都没有 → 不传，由 runner 落共享工作目录（REPO_DIR）或隔离 scratch。
    //
    // B3b-i（决策 D1）：代码类 WU（task/bug/feature/refactor）解析出 git 仓库根后，
    // 不再直接改共享目录 —— 执行 cwd 换成该仓库的专属 worktree
    // （<worktreesDir>/wu-<wuId>，分支 task/<wuId>）。同一 WU 跨 step 复用：
    // 首个 step 创建并把 worktreePath/branch/baseBranch/baseRepo 记入 metadata，
    // 后续 step 经 ensureWuWorktree 按目录存在性复用。创建失败走 B1 失败分支
    // （action='failed' → consecutiveStuck → 3 次 blocked），绝不静默退回共享目录。
    // 解析不出 git 仓库（无绑定根 / 根目录无 .git）→ 维持现状。
    // #157（T6）：analysis 原型单（建单显式 metadata.prototype=true）同样挂专属 worktree，
    // 分支前缀 prototype/（永不合并）；无标记的普通 analysis 行为逐字节不变。
    const cwdDeps = { getWuById: (wuId: string) => host.workUnitService.getById(wuId) };
    let workspaceRoot = resolveExecutionWorkspaceRoot(metadata);
    const wantsWuWorktree = CODE_WORKTREE_TYPES.has(wu.type)
      || (wu.type === 'analysis' && metadata.prototype === true);
    if (wantsWuWorktree && workspaceRoot && isGitRepoRoot(workspaceRoot)) {
      try {
        // PMO-b（决策 3）：WU 归属 PMO → base 从默认分支改为 PMO 分支（分支名 = PMO id），
        // per-WU 临时分支从 PMO 分支拉、向 PMO 分支合（merge-on-review-pass 消费 pmoBranch 落档）。
        // 解析/建支失败回落默认 base，绝不阻断执行。
        let pmoBaseBranch: string | null = null;
        const pmoResolution = await resolvePmoBranchForWU(wu, host.fileStore).catch(() => null);
        if (pmoResolution) {
          try {
            await ensureBranchExists({
              repoDir: workspaceRoot,
              branch: pmoResolution.branch,
              baseBranch: typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
                ? metadata.worktreeBaseBranch
                : getDefaultBranch(workspaceRoot),
            });
            pmoBaseBranch = pmoResolution.branch;
          } catch (err) {
            logger.warn(`[AgentLoop] PMO branch ensure failed, falling back to default base: ${getErrorMessage(err)}`, { traceId });
          }
        }
        const info = await ensureWuWorktree({
          wuId: wu.id,
          repoDir: workspaceRoot,
          worktreesDir: resolveWorktreesDir(),
          baseBranch: pmoBaseBranch
            ?? (typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
              ? metadata.worktreeBaseBranch
              : undefined),
          // #157（T6）：analysis 原型单分支 = prototype/<wuId>（永不合并）
          branchPrefix: wu.type === 'analysis' ? 'prototype' : undefined,
        });
        if (metadata.worktreePath !== info.worktreePath) {
          metadataUpdates.worktreePath = info.worktreePath;
          metadataUpdates.worktreeBranch = info.branch;
          metadataUpdates.worktreeBaseBranch = info.baseBranch;
          metadataUpdates.worktreeBaseRepo = info.baseRepo;
          if (pmoResolution && pmoBaseBranch) {
            // 2026-08 归因统一：只落 pmoBranch（merge-on-review-pass 的合并目标）；
            // 项目 id 不再缓存落档（原 pmoProjectId 为冗余缓存），消费方经
            // resolvePmoProjectIdForWU 从创建期戳（metadata.pmoId / reqId）重解析
            metadataUpdates.pmoBranch = pmoResolution.branch;
          }
        }
        workspaceRoot = info.worktreePath;
      } catch (err) {
        const message = getErrorMessage(err);
        logger.error(`[AgentLoop] Worktree creation failed for ${wu.id}: ${message}`, { traceId });
        // 会话签发在 worktree 解析之后（#94），此处尚无会话簿记需重置
        return {
          action: 'failed' as const,
          summary: `worktree 创建失败: ${message.slice(0, 500)}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'worktree_creation_failed',
            errorDetail: message.slice(0, 500),
            errorAt: new Date().toISOString(),
          },
        };
      }
    } else if (wu.type === 'review') {
      // B3b-i: review WU 继承父 WU worktree（评审能看到 diff）；父无 worktree → 维持现状
      const parentWorktree = await resolveParentWorktreePath(wu, cwdDeps);
      if (parentWorktree) workspaceRoot = parentWorktree;
    }

    // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
    // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
    // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
    // （取值前移：续用判定需要 provider）
    const taskProvider = (host.role.provider || 'claude') as AgentTask['provider'];
    // 续用判定（#94 per-WU 化 + #639 按 CLI 真实会话号点名续用）：只信档案，不读 instance 槽位。
    // 候选号选取：claude = metadata.sessionId（档案 UUID 即 claude CLI 真实会话号，会话按
    // (HOME, cwd) 存储，2.1.80 实测异 cwd --resume 报 "No conversation found with session ID"
    // ——cwd 取本步最终 workspaceRoot，会话文件不在 → 直接走新建）；kimi/codex/opencode =
    // metadata.cliSessionId（CLI 真实会话号，无 id 文件可查 → 只判有无，编号失效由 CLI
    // 报错 + #94 降级链兜底）。无 CLI 会话号 = 新建——cwd 维度「接最新」已撤除（#637：
    // 非代码 WU 共享 cwd，交错执行静默接错别家会话）。
    const resumeCandidateId = taskProvider === 'claude' ? metadata.sessionId : metadata.cliSessionId;
    const resumeSessionId = shouldResumeSession(taskProvider, resumeCandidateId, workspaceRoot)
      ? resumeCandidateId!
      : null;
    // #639：续用决策日志（可 grep：provider / 是否续用 / cwd / CLI 真实会话号）
    logger.info('[AgentLoop] session resume decision', {
      workUnitId: wu.id,
      provider: taskProvider,
      resumed: resumeSessionId !== null,
      cwd: workspaceRoot ?? null,
      cliSessionId: metadata.cliSessionId ?? null,
      traceId,
    });

    // prompt 组装与上下文注入（hint 读取/注入/消费清除、skill > persona > roster > knowledge
    // 共用分段软定额注入）已抽到 ./prompt-composer.js（2026-08 工单 05）——agentStep 只保留编排。
    // #95: 续用判定在 worktree 解析后、prompt 组装前完成 —— isNewSession（续用不命中）决定
    // 是否注入「前序进展」段与回放 waitingQuestion。
    const composeDeps = {
      role: host.role, acceptedTypes: host.acceptedTypes, fileStore: host.fileStore,
      resolveEventsFile: resolveStudioEventsFile,
    };
    const composed = await composeStepPrompt(
      { wu, metadata, newReplies: target.newReplies?.map(r => r.content), isNewSession: !resumeSessionId },
      composeDeps,
    );
    const { prompt, pendingReplies, knowledgeContext, skillMatched, injectedKnowledgeIds } = composed;
    if (skillMatched.length > 0) {
      // 决策 7: step 时匹配名单落盘 metadata.matchedSkills（随 recordResult 原子写入，
      // 供 skill-demotion 成功率与被无视率度量——替代原 claim 时 fire-and-forget 落盘，消竞态）
      metadataUpdates.matchedSkills = skillMatched;
    }
    // 已消费 hint（pendingReplies/commitGuardHint/verifyFailHint/childGuardHint/processCheckHint）的清除增量
    // （undefined 在 JSON 序列化时丢弃，清除避免后续步骤重复注入）
    Object.assign(metadataUpdates, composed.consumedHintUpdates);

    let newSessionId: string | null = null;
    // B5（2026-08-03 token-burn issue P1-1，决策记录 #3）：每 WU 会话数上限。
    // 新建会话 = 从零重读 SKILL.md/探索文件 + 后续 step 全文重放，是最大的 token 放大器；
    // 超限转 need_input 等人工评估，替代静默重开。旧数据无 sessionCount 字段：已有 sessionId 的按已用 1 个计。
    const sessionsUsed = metadata.sessionCount ?? (metadata.sessionId ? 1 : 0);
    if (!resumeSessionId) {
      if (sessionsUsed >= MAX_SESSIONS_PER_WU) {
        logger.warn('[AgentLoop] Session limit reached — need human evaluation', {
          workUnitId: wu.id, sessionsUsed, max: MAX_SESSIONS_PER_WU,
        });
        return {
          action: 'need_input' as const,
          summary: `会话重建已达上限（${sessionsUsed}/${MAX_SESSIONS_PER_WU}）：反复从零重开会话会全文重放烧钱，已暂停自动执行。请人工评估后回复任意内容继续，或直接关闭任务`,
          metadataUpdates,
        };
      }
      newSessionId = randomUUID();
      metadataUpdates.sessionId = newSessionId;
      metadataUpdates.sessionCount = sessionsUsed + 1;
      metadataUpdates.startedAt = new Date().toISOString();
      metadataUpdates.lastSessionResumed = false;
    } else {
      // sessionResumes 不在此预增——#94 起只计实际续用成功的步（见成功路径统一落账）
      metadataUpdates.lastSessionResumed = true;
    }
    // 本步最终实际会话形态（续用降级重试后会被改写：换新号 + resumed=false）
    let effectiveSessionId: string | null = resumeSessionId ?? newSessionId;
    let sessionResumed = resumeSessionId !== null;
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
        agentProfileId: host.role.id,
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

    // M2 成本红线度量 + B6 真实 token 记账（2026-08-03 token-burn issue P1-2）：
    // 成功与失败执行都记 workunit:tokens（失败照样烧 token）。fire-and-forget，绝不影响任务流程。
    const recordTokenEvent = (res: ExecutionResult): RealUsage | null => {
      // #134: usage 解析按 provider 分流（opencode/codex 事件形态与 claude 不同）
      const real = resolveRealUsage(res, taskProvider);
      void writeWorkunitTokenEvent(resolveStudioEventsFile(), {
        workUnitId: wu.id,
        channelId: wu.channelId,
        executionId: task.executionId,
        injectedTokens: estimateTokens(knowledgeContext),
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
      return real;
    };

    // #172（#60 决策 Q1）：失败步也落 execution_step 事件（status='failed' + 错误字段）——
    // 此前失败分支提前 return 到不了成功路径的发射点，失败步在事件流中完全不可查。
    // 读取调用时的 effectiveSessionId/sessionResumed 当前值（重试降级后可能被改写）。
    // fire-and-forget，与成功路径发射同形态，绝不影响失败处理流程。
    const emitFailedStep = (action: string, detail: string, res?: ExecutionResult) => {
      // #453: 失败路径保持按原文解析（票内决议）——失败步仅此一个消费点，解析一次；
      // 成功路径的解析产物复用不延伸到这里（失败步与成功步互斥，无重复解析可省）。
      const failedRaw = res?.rawOutput;
      const failedCliSessionId = failedRaw ? extractCliSessionId(taskProvider, failedRaw) : null;
      void emitExecutionStepEvent({
        workUnitId: wu.id,
        channelId: wu.channelId,
        executionId: task.executionId,
        sessionId: effectiveSessionId ?? undefined,
        // #639: 失败步同样落 CLI 真实会话号（流内有才带，不编造）
        ...(failedCliSessionId ? { cliSessionId: failedCliSessionId } : {}),
        sessionResumed,
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
      host.currentExecutionId = executionId;
      // §9.6: 经 Executor 接口执行（P0 恒为 LocalExecutor → agentRunner.executeLightweight）
      let result: ExecutionResult = await host.executor.execute(task);

      // W-3 接线：runner 失败时返回 { success:false } 而不抛错、且无 outputText ——
      // 直接落入 parseAgentOutput 会得到默认 progress（空 summary），导致 consecutiveStuck
      // 被清零、每 3s 重试、往频道发空消息。显式失败分支：action='failed'，由 recordResult
      // 记 consecutiveStuck + errorType/errorDetail，并发「执行失败（第 N 次）」系统消息
      // （#175/#55 决议）；连续 3 次走 blocked 里程碑路径。
      // 不带 channelVersion —— 失败消息是系统通知不是结果回帖，不参与 §4.2 新鲜度判定。
      if (result.success === false) {
        const failResult = (detail: string) => ({
          action: 'failed' as const,
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
        recordTokenEvent(result);
        // #543: #94 续用丢失降级与 #96 上下文溢出两段孪生重试骨架（配额判定 → 改参 →
        // 重算 prompt → 再执行 → 成败分叉 → 簿记回写）收编到 ./step-retry-policy.js ——
        // 本处只保留编排：注入 executor/prompt 重算/记账/失败事件 deps，按 outcome 分流。
        // 非续用类错误（超时/业务失败）与 catch 分支（spawn 异常）不触发；每步至多烧一次重试。
        const retryOutcome = await runStepRetry(
          { wu, metadata, provider: taskProvider, task, firstResult: result, detail, sessionsUsed, resumeSessionId, metadataUpdates, traceId },
          {
            execute: (t) => host.executor.execute(t),
            recomposePrompt: async ({ isNewSession }) => (await composeStepPrompt(
              { wu, metadata, newReplies: target.newReplies?.map(r => r.content), isNewSession },
              composeDeps,
            )).prompt,
            recordTokenEvent,
            recordFailureOutcome: (d) => this.recordOutcomeEvent(wu, false, d, 'execution_failed', injectedKnowledgeIds),
            emitFailedStep,
          },
        );
        if (retryOutcome.kind === 'terminal') return retryOutcome.result;
        if (retryOutcome.kind === 'retried') {
          // 重试成功：走正常成功路径；换新号（簿记已由策略写入 metadataUpdates）
          result = retryOutcome.result;
          effectiveSessionId = retryOutcome.sessionId;
          sessionResumed = false;
        } else {
          // 非重试类失败（no-retry）：首 step 失败会话未必已建立，重置避免下步 --resume
          // 一个从未建立的会话
          if (newSessionId) resetUnestablishedSessionBookkeeping(metadataUpdates);
          this.recordOutcomeEvent(wu, false, detail, 'execution_failed', injectedKnowledgeIds);
          emitFailedStep('failed', detail, result);
          return failResult(detail);
        }
      }

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
      const realUsage = recordTokenEvent(result);

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
          writeToolCallEvents(stepEvents, resolveToolTraceFile(), { caller: host.role.id });
        } catch { /* non-blocking */ }
      }

      // #97: transcript 归档 —— 本步原文（raw CLI stdout，provider 无关）追加到 per-WU
      // 归档文件（JSONL，studioPath('transcripts/<wuId>.jsonl')）。三消费方（#99 WU 收尾
      // 提取、handoff 摘要、#85 执行质量评估）共用；fire-and-forget，失败绝不阻断任务流程。
      if (toolTraceSource) {
        void appendTranscriptStep({
          workUnitId: wu.id,
          sessionId: effectiveSessionId ?? undefined,
          step: stepNo,
          action: stepResult.action,
          rawOutput: toolTraceSource,
        }).catch(() => {});
      }

      // WU 过程可视化：执行步事件（本步思考/工具调用/skill 注入/用量 → 事件流落盘 + SSE，
      // WU 详情抽屉消费；不进频道、不写 metadata 防膨胀）。fire-and-forget。
      void emitExecutionStepEvent({
        workUnitId: wu.id,
        channelId: wu.channelId,
        executionId: task.executionId,
        sessionId: effectiveSessionId ?? undefined,
        // #639: 本步 CLI 真实会话号（与该步 transcript rawOutput 中的编号一致，可对照）
        ...(stepCliSessionId ? { cliSessionId: stepCliSessionId } : {}),
        // #94: 本步最终实际的续用形态（续用降级重试后 = false）
        sessionResumed,
        step: stepNo,
        action: stepResult.action,
        // #453: 复用上方统一解析的 stepEvents（与 tool:call 落盘共享同一份解析产物）
        events: stepEvents,
        skills: skillMatched,
      }).catch(() => {});

      // GAP-6: recordOutcome + extractFromExecution (non-blocking)
      // R1: 携带本次注入的知识条目 id，反馈环才有数据
      this.recordExecutionOutcome(wu, result, injectedKnowledgeIds).catch(() => {});

      // R3 会话提取（断点 B）：任务 COMPLETE → 触发一次 LLM 知识提取（proposal 入库，
      // 审核前不注入）。模板式 extractFromExecution 保留为始终在线的兜底，两条链路独立。
      // fire-and-forget：无 LLM 配置/提取失败仅记日志，绝不影响任务完成。
      // 去重：metadata.knowledgeExtractedAt 标记后不再重复提取（随 recordResult 原子写入持久化）。
      if (stepResult.action === 'complete' && !metadata.knowledgeExtractedAt) {
        metadataUpdates.knowledgeExtractedAt = new Date().toISOString();
        const conversation = [
          { role: 'user', content: wu.scope ?? '' },
          ...pendingReplies.map(content => ({ role: 'user', content })),
          { role: 'assistant', content: stepResult.summary },
        ];
        try {
          void knowledgeService.extractFromConversation?.(conversation, { workUnitId: wu.id })
            ?.catch((err: unknown) =>
              logger.warn(`[AgentLoop] extractFromConversation failed: ${getErrorMessage(err)}`)
            );
        } catch { /* non-blocking */ }
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

      return { ...stepResult, metadataUpdates, channelVersion };
    } catch (err) {
      // W-3 fix: executeLightweight 失败返回 { success:false } 不抛错 —— 已在上方
      // success===false 显式分支接线（consecutiveStuck → blocked）；本 catch 只覆盖
      // 真正抛出的异常（如 spawn 失败），保持 need_input 语义。
      // 首 step 抛异常：会话未建立，重置避免下步 --resume 空 id
      if (newSessionId) resetUnestablishedSessionBookkeeping(metadataUpdates);
      const message = getErrorMessage(err);
      logger.error(`[AgentLoop] agentStep execute failed: ${message}`, { traceId });
      this.recordOutcomeEvent(wu, false, message, 'execution_failed', injectedKnowledgeIds);
      // #172: spawn 异常等抛出路径的失败步同样落 execution_step（status=failed）
      emitFailedStep('need_input', message);
      // AC-8.7 远程节点不可达分支已随 RemoteExecutor 一并删除（远程方向放弃，bdaf0dd3）。
      return {
        action: 'need_input' as const, // increments consecutiveStuck
        summary: `Agent execution failed: ${message}`,
        metadataUpdates,
      };
    } finally {
      // #178: 步结束（含被杀/异常）清除当前 executionId，fencing 杀进程组只针对在飞步
      host.currentExecutionId = null;
    }
  }

  /** Record execution outcome to knowledge service (GAP-6, non-blocking).
   *  R1: consumedKnowledge = 本次 agentStep 经 injectContext 实际注入的知识条目 id。
   *  #90: outcome 事件经 recordOutcomeEvent 单一正本落盘；本方法覆盖成功步（+ 会话提取）。
   *  失败步由 agentStep 失败分支直接调 recordOutcomeEvent（success=false + errorType）。 */
  private async recordExecutionOutcome(wu: WorkUnitData, result: ExecutionResult, consumedKnowledge: string[] = []): Promise<void> {
    this.recordOutcomeEvent(wu, result.success, result.outputText ?? '', undefined, consumedKnowledge);
    try {
      await knowledgeService.extractFromExecution({
        task: wu.scope ?? '',
        diff: result.outputText ?? '',
        success: result.success,
        duration: result.totalDurationMs ?? 0,
        agentType: 'claude',
        consumedKnowledge,
      });
    } catch {
      // Non-blocking
    }
  }

  /** #90: knowledge:outcome 事件单一正本 —— success/failure 统一经此落盘，避免两套漂移。
   *  errorType 仅失败步携带（success 时 undefined，JSON.stringify 丢弃）。fire-and-forget。 */
  private recordOutcomeEvent(wu: WorkUnitData, success: boolean, details: string, errorType: string | undefined, consumedKnowledge: string[]): void {
    void knowledgeService.recordOutcome({
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
