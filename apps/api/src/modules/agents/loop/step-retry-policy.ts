/**
 * 步执行重试策略（#543，2026-09 架构评审 A3）：收编 agentStep 中段两段孪生重试骨架 ——
 * #94「续用丢失降级」（续用步报「会话不存在」→ 换发新 sessionId 按新建重试一次）与
 * #96「上下文溢出重试」（溢出错误 → 滚动摘要落盘 → 新会话带摘要重试一次 → 再败 NEED_INPUT）。
 * 两段原各写一遍「配额判定 → 改参 → 重算 prompt → 再执行 → 成败分叉 → 簿记回写」，
 * 本模块收敛为 runStepRetry 一份；差异（触发条件/prompt 重算参数/再败的 terminal 形状）
 * 以 StepRetryKind 参数化。
 *
 * 职责边界：
 *   - 本模块 = 重试政策（retry policy）：触发判定（matchStepRetry）、会话配额占额、
 *     会话簿记回写、重试 task 改写与再执行的调用编排。
 *   - agent-loop.agentStep = 编排：首次执行失败 → 调 runStepRetry → terminal 直接返回 /
 *     retried 改写 result 走正常成功路径 / no-retry 走既有 failed 路径。
 *
 * 可测试性：executor/prompt 重算/记账/失败事件全部经 deps 注入（同 step-guards 的
 * Ctx/Deps/Outcome 模式），单测 fake executor 直测，无需整类构造 AgentLoop。
 * 重试复用 #94 设计：同一 task 对象原地改 parameters/prompt 再执行。
 */

import { randomUUID } from 'crypto';
import { logger } from '@dommaker/studio-shared';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { StepResult } from './agent-loop.types.js';
import { RESUME_FAILURE_RE } from './session-resume.js';
import { isContextOverflowError, buildRollingSummary, OVERFLOW_SUMMARY_HEADER } from './context-overflow.js';

/** B5（2026-08-03 token-burn issue P1-1）：每 WU 独立会话数上限（#95 由 2 放宽到 5）。
 *  会话反复重建（stuck 重开 / token 截断重开）意味着整段 transcript 全文重放重新烧一遍；
 *  超限说明自动执行已失控，转 need_input 等人工评估（#94 起人工回复不再重置预算——
 *  复活后凭 metadata.sessionId 优先续用旧会话，见 waiting-input.ts）。
 *  #95: 失败/超时的会话建立尝试计入预算（resetUnestablishedSession 不再清 sessionCount）。
 *  #543: 常量从 agent-loop 迁入本模块（重试配额判定的真属主），agent-loop 新建签发复用。 */
export const MAX_SESSIONS_PER_WU = 5;

/** 重试种类：session-resume-lost = #94 续用丢失降级；context-overflow = #96 溢出重试 */
export type StepRetryKind = 'session-resume-lost' | 'context-overflow';

/**
 * 重试触发判定（纯函数）。顺序即优先级：
 *  1. 续用步（resumeSessionId 在场）+「会话不存在」类错误 → session-resume-lost。
 *     非续用步报同款错误不触发降级（会话本就不是续用目标，无链可断）。
 *  2. 溢出类错误（续用/新建步皆可）→ context-overflow。
 *  其余错误（超时/业务失败）→ null，走既有 failed 路径；catch 分支（spawn 异常）不进本函数。
 */
export function matchStepRetry(input: { resumeSessionId: string | null; detail: string }): StepRetryKind | null {
  if (input.resumeSessionId && RESUME_FAILURE_RE.test(input.detail)) return 'session-resume-lost';
  if (isContextOverflowError(input.detail)) return 'context-overflow';
  return null;
}

/** 重试策略输入。task 与 metadataUpdates 为原地改写对象（#94 设计 + 簿记断言点）。 */
export interface StepRetryCtx {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  /** profile provider（registry id）——仅 claude 给 CLI 传新 sessionId（kimi/codex/opencode 续用语义不传） */
  provider: string;
  /** 首次执行的 task（重试时原地改 parameters.sessionId/sessionResume 与 prompt 后再执行） */
  task: AgentTask;
  /** 首次失败结果（budget-exceeded terminal 的 emitFailedStep 携带） */
  firstResult: ExecutionResult;
  /** 首次失败 detail（已截 500 字符） */
  detail: string;
  /** 本步前已用会话数（metadata.sessionCount ?? 有 sessionId 按 1 计，agent-loop 口径） */
  sessionsUsed: number;
  /** 本步续用目标（null = 新建步） */
  resumeSessionId: string | null;
  /** 本步簿记增量（原地改写：占额 sessionCount / 回写 sessionId/lastSessionResumed/sessionSummary） */
  metadataUpdates: Partial<WorkUnitMetadata>;
  /** P0 修复 6 traceId 透传（#552）：与首败日志同一字段，串联重试段日志；无 trace 链路可缺省 */
  traceId?: string;
}

/** 重试策略外部依赖（agent-loop 绑定注入；单测整体注入伪实现）。 */
export interface StepRetryDeps {
  /** 再执行（agent-loop 注入 this.executor.execute；fake executor 注入形状 = 本签名） */
  execute: (task: AgentTask) => Promise<ExecutionResult>;
  /** prompt 重算（agent-loop 注入 composeStepPrompt 的同款 ctx/deps 调用，只回传 prompt 文本） */
  recomposePrompt: (opts: { isNewSession: boolean }) => Promise<string>;
  /** B6 token 记账（仅重试再败时调用；重试成功由 agent-loop 成功路径统一记账） */
  recordTokenEvent: (res: ExecutionResult) => unknown;
  /** #90 failure outcome 落盘（agent-loop 绑死 success=false + errorType='execution_failed' + 注入知识 ids） */
  recordFailureOutcome: (detail: string) => void;
  /** #172 失败步 execution_step 事件（agent-loop 闭包，读取 effectiveSessionId/sessionResumed 当前值） */
  emitFailedStep: (action: 'failed' | 'need_input', detail: string, res?: ExecutionResult) => void;
  /** 新会话号签发（默认 randomUUID；单测注入定值） */
  newSessionId?: () => string;
  /** 会话配额上限（默认 MAX_SESSIONS_PER_WU；单测可注入小值） */
  maxSessionsPerWu?: number;
}

export type StepRetryOutcome =
  /** 未触发重试：agent-loop 走既有 failed 路径 */
  | { kind: 'no-retry' }
  /** 重试成功：agent-loop 以 result 替换首败结果、sessionId 改写有效会话号、sessionResumed=false，走正常成功路径 */
  | { kind: 'retried'; result: ExecutionResult; sessionId: string }
  /** 重试序终结（配额满 / 再败）：agentStep 直接返回该 StepResult */
  | { kind: 'terminal'; result: StepResult };

/**
 * 首 step（新建会话）执行失败 / 降级重试仍失败时重置会话簿记：CLI 会话未必已建立
 * （可能根本没 spawn 到），不重置则下一步按续用发 `--resume <从未建立的 id>`
 * （claude 必报 "No conversation found"）。续用 step 失败不调用 —— 会话已存在，
 * 保留下一步继续 resume。
 * #95: sessionCount 不清除 —— 失败/超时的会话建立尝试计入预算（超限转 need_input）。
 * #543: 从 agent-loop 私有方法提为模块级纯函数（重试再败路径的簿记断言点），
 * agent-loop 的 resetUnestablishedSession 委托本函数（单一正本）。
 */
export function resetUnestablishedSessionBookkeeping(metadataUpdates: Partial<WorkUnitMetadata>): void {
  delete metadataUpdates.sessionId;
  delete metadataUpdates.lastSessionResumed;
}

/**
 * 重试序统一骨架（两段孪生块的收敛体）：
 *  触发判定 → [溢出：摘要先落盘] → 配额判定（满 → terminal need_input，不起新会话）→
 *  签发新号 + task 改新建形态 + sessionCount 计入 → prompt 重算（降级 isNewSession:true；
 *  溢出 isNewSession:false + 追加摘要段）→ 再执行 →
 *  再败（重置簿记 + 记账 + failure outcome + failed 步事件 → terminal；降级=failed，溢出=need_input）/
 *  成功（簿记落新号 → retried）。
 */
export async function runStepRetry(ctx: StepRetryCtx, deps: StepRetryDeps): Promise<StepRetryOutcome> {
  const kind = matchStepRetry({ resumeSessionId: ctx.resumeSessionId, detail: ctx.detail });
  if (!kind) return { kind: 'no-retry' };

  const { wu, metadata, task, metadataUpdates } = ctx;
  const maxSessions = deps.maxSessionsPerWu ?? MAX_SESSIONS_PER_WU;

  // #96: 溢出先落滚动摘要（配额满转人工时也保留供人工参考）；来源 = wu.scope + progressLog，
  // 不递归摘要、不建语义搜索。摘要字段与 buildRollingSummary 单一正本在 context-overflow.ts。
  let overflowSummary: string | null = null;
  if (kind === 'context-overflow') {
    overflowSummary = buildRollingSummary(wu.scope, metadata);
    metadataUpdates.sessionSummary = overflowSummary;
  }

  // 配额判定（#96 收口 #95 降级超限先例）：两种重试都 = 一次新建会话尝试，遵守
  // MAX_SESSIONS_PER_WU，超限 terminal need_input 转人工，不静默绕过 MAX。
  if (ctx.sessionsUsed >= maxSessions) {
    const summary = kind === 'session-resume-lost'
      ? `续用会话已丢失且会话重建已达上限（${ctx.sessionsUsed}/${maxSessions}）：已暂停自动执行。请人工评估后回复任意内容继续，或直接关闭任务`
      : `CLI 上下文溢出且会话重建已达上限（${ctx.sessionsUsed}/${maxSessions}）：已暂停自动执行。请人工评估后回复任意内容继续，或直接关闭任务`;
    logger.warn(`[AgentLoop] ${kind === 'session-resume-lost' ? 'Resume session lost' : 'Context overflow'} and session limit reached — need human evaluation`, {
      workUnitId: wu.id, sessionsUsed: ctx.sessionsUsed, max: maxSessions, traceId: ctx.traceId,
    });
    deps.recordFailureOutcome(ctx.detail);
    deps.emitFailedStep('need_input', ctx.detail, ctx.firstResult);
    return { kind: 'terminal', result: { action: 'need_input' as const, summary, metadataUpdates } };
  }

  const fallbackSessionId = (deps.newSessionId ?? randomUUID)();
  logger.warn(
    kind === 'session-resume-lost'
      ? `[AgentLoop] Resume target session lost for ${wu.id} — falling back to a new session`
      : `[AgentLoop] Context overflow for ${wu.id} — persisting rolling summary and retrying in a new session`,
    { traceId: ctx.traceId },
  );
  task.parameters!.sessionId = ctx.provider === 'claude' ? fallbackSessionId : undefined;
  delete task.parameters!.sessionResume;
  // 重试 = 一次新建会话尝试，成败均计入会话预算（#95 失败/超时尝试计入语义）
  metadataUpdates.sessionCount = ctx.sessionsUsed + 1;

  // prompt 重算（复用 agent-loop 同一 ctx/deps；knowledge/skill 等段重复组装一次，
  // 副作用均 fire-and-forget）：
  //  - 降级：isNewSession=true —— 断链新会话（check 判命中、执行才发现丢失，未注入前序进展），
  //    重算注入「前序进展」段 + 回放 waitingQuestion；
  //  - 溢出：isNewSession=false（避免与 handoff 前序进展段重复），摘要段单独追加。
  const recomposedPrompt = await deps.recomposePrompt({ isNewSession: kind === 'session-resume-lost' });
  task.prompt = kind === 'context-overflow'
    ? `${recomposedPrompt}\n\n${OVERFLOW_SUMMARY_HEADER}\n\n${overflowSummary}`
    : recomposedPrompt;

  const retryResult: ExecutionResult = await deps.execute(task);
  if (retryResult.success === false) {
    const retryDetail = (retryResult.error ?? '未知错误').slice(0, 500);
    logger.error(`[AgentLoop] agentStep ${kind === 'session-resume-lost' ? 'fallback' : 'overflow'} retry failed for ${wu.id}: ${retryDetail}`, { traceId: ctx.traceId });
    deps.recordTokenEvent(retryResult);
    // 新会话未建立：sessionId/lastSessionResumed 回滚；sessionCount 保留计入（#95）；
    // 溢出的 sessionSummary 保留落盘供人工参考
    resetUnestablishedSessionBookkeeping(metadataUpdates);
    deps.recordFailureOutcome(retryDetail);
    if (kind === 'session-resume-lost') {
      // 降级再败 → 既有 failed 返回（记 consecutiveStuck，连续 3 次走 blocked 里程碑）
      deps.emitFailedStep('failed', retryDetail, retryResult);
      return {
        kind: 'terminal',
        result: {
          action: 'failed' as const,
          summary: `CLI 执行失败: ${retryDetail}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'execution_failed',
            errorDetail: retryDetail,
            errorAt: new Date().toISOString(),
          },
        },
      };
    }
    // 溢出再败 → NEED_INPUT（合流既有 need_input 路径，不再三连败静默 blocked）
    deps.emitFailedStep('need_input', retryDetail, retryResult);
    return {
      kind: 'terminal',
      result: {
        action: 'need_input' as const,
        summary: `CLI 上下文溢出：新会话带摘要重试一次仍失败（${retryDetail.slice(0, 200)}），已暂停自动执行。请人工评估后回复任意内容继续，或直接关闭任务`,
        metadataUpdates,
      },
    };
  }

  // 重试成功：换新号落盘（sessionCount 已在查过 MAX 后计入），agent-loop 走正常成功路径
  metadataUpdates.sessionId = fallbackSessionId;
  metadataUpdates.lastSessionResumed = false;
  return { kind: 'retried', result: retryResult, sessionId: fallbackSessionId };
}
