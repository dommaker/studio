/**
 * 入口守卫链（#541，2026-09 从 agent-loop.agentStep 头部原样抽出，行为一字不改，
 * 对称补齐出口侧 completion-gates）：agentStep 的四段「该不该跑这一步」前置判定 ——
 * B2 测试特征 WU 守卫 → C3 日 token 预算熔断 → #162 WU 级 token 预算熔断 → #471 plan 步数额度熔断。
 * 顺序即优先级：首个命中的守卫短路返回 StepResult，后续守卫不再执行（与原内联行为一致）。
 *
 * 职责边界：
 *   - 本模块 = 守卫政策（guard policy）：判定/短路结果/B2 留痕副作用的调用编排。
 *   - agent-loop.agentStep = 编排：构建 ctx → 调 runStepGuards → 命中即返回，
 *     放行则继续 traceId/频道版本/worktree/会话签发/prompt 组装。
 *
 * 可测试性：B2 副作用（WU 写盘/关闭/频道通知）与事件流路径经 deps 注入（agent-loop 绑定
 * workUnitService/postToDiscussionSpace/studioEventsJsonlPath）；守卫开关与外部数据源
 * （日预算用量/告警）有生产默认实现，单测整体注入伪实现，无需 vi.mock 模块工厂。
 */

import { logger } from '@dommaker/studio-shared';
import { PLAN_STEP_LIMIT } from '../../workunit/workunit.types.js';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { StepResult } from './agent-loop.types.js';
import { testWuGuardEnabled, isTestLikeWorkUnit } from './agent-loop-guards.js';
import {
  tokenBudgetGuardEnabled, resolveDailyTokenBudget, getDailyTokenUsage,
  notifyBudgetTripped, type DailyTokenUsage,
} from './daily-token-budget.js';

/** 守卫链输入：wu + 已解析的 metadata（agentStep 入口 parseWuMetadata 的同一对象） */
export interface StepGuardCtx {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
}

/** 守卫链外部依赖。前四项为编排层绑定（agent-loop 注入），无默认实现；
 *  其余为开关/数据源，默认 = 生产实现，单测整体注入伪实现。 */
export interface StepGuardDeps {
  /** B2: WU metadata 写盘留痕（agent-loop 注入 workUnitService.update(id, { metadata })） */
  updateWuMetadata: (wuId: string, metadata: WorkUnitMetadata) => Promise<unknown>;
  /** B2: 关闭 WU（agent-loop 注入 workUnitService.transitionStatus(id, 'closed')） */
  closeWu: (wuId: string) => Promise<unknown>;
  /** B2: 频道留痕（agent-loop 注入 postToDiscussionSpace） */
  postNotice: (wuId: string, text: string) => Promise<unknown>;
  /** C3: 事件流文件路径（agent-loop 注入 studioEventsJsonlPath，惰性解析 env 覆盖） */
  eventsFilePath: () => string;
  /** B2 守卫开关（默认读 process.env；测试环境默认关闭，STUDIO_TEST_WU_GUARD 覆盖） */
  testWuGuardEnabled?: () => boolean;
  /** B2 测试特征判定（metadata 显式标记或 scope 命中测试名单模式） */
  isTestLikeWorkUnit?: (wu: { scope: string }, metadata: WorkUnitMetadata) => boolean;
  /** C3 守卫开关（默认读 process.env；STUDIO_TOKEN_BUDGET_GUARD 覆盖） */
  tokenBudgetGuardEnabled?: () => boolean;
  /** C3: 每日预算（STUDIO_DAILY_TOKEN_BUDGET 覆盖；<=0 = 不熔断） */
  resolveDailyTokenBudget?: () => number;
  /** C3: 当日已耗查询（进程内计数器 + 首查/跨天全量扫） */
  getDailyTokenUsage?: (opts: { eventsFile: string }) => Promise<DailyTokenUsage>;
  /** C3: 当日首次熔断告警（budget-tripped 事件留痕 + 通知出口） */
  notifyBudgetTripped?: (opts: { eventsFile: string; usedTokens: number; budget: number }) => Promise<void>;
}

export interface StepGuardOutcome {
  /** 非 null = 守卫短路：agentStep 直接返回该 StepResult；null = 放行继续执行 */
  result: StepResult | null;
}

/**
 * 依次跑入口守卫（顺序即优先级，首个命中即短路）：
 *  1. B2 测试特征 WU 守卫：不起会话、直接关闭（留痕 testWorkUnitGuard + blockReason + 频道通知）。
 *  2. C3 日 token 预算熔断：当日 billed 消耗 ≥ 预算 → need_input 挂起（次日零点复位或人工处置）；
 *     全局当日只告警一次（budget-tripped 事件留痕）。
 *  3. #162 WU 级 tokenBudget 熔断：metadata.tokenBudget 显式数值在场即生效（不吃 C3 开关），
 *     超线 → need_input 挂起 + waitingReason='wu-token-budget'（人三选：追加预算/收尾/放弃）。
 *  4. #471 plan 步数额度熔断：stepCount ≥ planStepAllowance（默认 PLAN_STEP_LIMIT）→
 *     need_input 挂 blocked 转人 + waitingReason='plan-step-limit'（人回复即续期）。
 */
export async function runStepGuards(
  ctx: StepGuardCtx,
  deps: StepGuardDeps,
): Promise<StepGuardOutcome> {
  const { wu, metadata } = ctx;
  const testGuardOn = deps.testWuGuardEnabled ?? (() => testWuGuardEnabled());
  const isTestLike = deps.isTestLikeWorkUnit ?? isTestLikeWorkUnit;
  const budgetGuardOn = deps.tokenBudgetGuardEnabled ?? (() => tokenBudgetGuardEnabled());
  const dailyBudgetOf = deps.resolveDailyTokenBudget ?? (() => resolveDailyTokenBudget());
  const dailyUsage = deps.getDailyTokenUsage ?? getDailyTokenUsage;
  const notifyTripped = deps.notifyBudgetTripped ?? notifyBudgetTripped;

  // B2 守卫（2026-08-03 token-burn issue P0-1c）：测试特征 WU 不起会话、直接关闭。
  // 历史事故：路由测试经共享数据根把测试 WU 写进生产 FileStore，daemon 当真任务逐个
  // 起 Claude 会话执行（16 个会话 420 万 token）。关闭留痕 testWorkUnitGuard + blockReason。
  if (testGuardOn() && isTestLike(wu, metadata)) {
    logger.warn('[AgentLoop] Test-like WorkUnit guarded — closing without execution', {
      workUnitId: wu.id, scope: wu.scope,
    });
    await deps.updateWuMetadata(wu.id, {
      ...metadata, testWorkUnitGuard: true, blockReason: 'test-wu-guard: 测试特征任务，守卫关闭',
    }).catch(err => logger.warn('[AgentLoop] test-wu guard metadata write failed', { workUnitId: wu.id, error: String(err) }));
    if (wu.status !== 'closed') {
      await deps.closeWu(wu.id)
        .catch(err => logger.warn('[AgentLoop] test-wu guard close failed', { workUnitId: wu.id, error: String(err) }));
    }
    await deps.postNotice(wu.id, '检测到测试特征任务，已跳过执行并关闭（防止测试数据空烧 token）')
      .catch(() => {});
    return { result: { action: 'skipped', summary: '' } };
  }

  // C3 守卫（2026-08-03 token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。
  // 当日 billed 口径消耗 ≥ 预算（默认 2M/日，STUDIO_DAILY_TOKEN_BUDGET 覆盖，<=0 关闭）→
  // 不起会话，WU 经 need_input 挂起（recordResult 落 waitingForInput + blockReason），
  // 等次日本地零点预算复位或人工处置；全局当日只告警一次（studio:budget-tripped 事件留痕）。
  // 用量走进程内计数器（daily-token-budget），仅首次/跨天全量扫一次事件文件，不拖慢热路径。
  if (budgetGuardOn()) {
    const dailyBudget = dailyBudgetOf();
    if (dailyBudget > 0) {
      const eventsFile = deps.eventsFilePath();
      const daily = await dailyUsage({ eventsFile });
      if (daily.usedTokens >= dailyBudget) {
        logger.warn('[AgentLoop] Daily token budget tripped — pausing automatic execution', {
          workUnitId: wu.id, usedTokens: daily.usedTokens, budget: dailyBudget,
        });
        if (!daily.notified) {
          await notifyTripped({ eventsFile, usedTokens: daily.usedTokens, budget: dailyBudget });
        }
        return {
          result: {
            action: 'need_input' as const,
            summary: `每日 token 预算已熔断（当日已用 ${daily.usedTokens.toLocaleString()} / 上限 ${dailyBudget.toLocaleString()}，billed 口径含 cache_read）：已暂停自动执行、不再起会话。次日（本地零点）预算复位后回复任意内容继续，或直接关闭任务`,
          },
        };
      }
    }
  }
  // #162（T8-E1，#130 决策 3）：WU 级 token 预算熔断。metadata.tokenBudget 显式数值
  // （任何类型 WU 可带，与日预算无关、不吃 STUDIO_TOKEN_BUDGET_GUARD 开关——字段在场即生效），
  // 对照 metadata._cumulativeTokens（billed 口径簿记，与日预算同口径）。超线复用日预算同款
  // need_input 挂起路径（recordResult 落 waitingForInput + blockReason），不新造状态；
  // waitingReason='wu-token-budget' 供 waiting-input 人三选分流（追加预算/收尾/放弃）。
  // 人读面说人话：提示文案不出现 WU/metadata/闸/熔断等机制黑话。
  if (typeof metadata.tokenBudget === 'number' && Number.isFinite(metadata.tokenBudget) && metadata.tokenBudget > 0) {
    const wuBudget = Math.floor(metadata.tokenBudget);
    const wuUsed = metadata._cumulativeTokens ?? 0;
    if (wuUsed >= wuBudget) {
      logger.warn('[AgentLoop] WU token budget reached — suspending for human decision', {
        workUnitId: wu.id, usedTokens: wuUsed, budget: wuBudget,
      });
      return {
        result: {
          action: 'need_input' as const,
          summary: `这项任务已消耗 ${wuUsed.toLocaleString()} token，达到为它设定的上限 ${wuBudget.toLocaleString()}，已暂停等你决定。回复：「追加预算」在上限之上再加 ${wuBudget.toLocaleString()} 继续执行；「追加预算 <数值>」把上限改为指定数值；「收尾」用现有产出提交审查；「放弃」结束任务`,
          metadataUpdates: { waitingReason: 'wu-token-budget' },
        },
      };
    }
  }
  // #471（Triage 定稿 1）：plan 步数额度熔断。一脉会话承载全规划链，额度高于
  // implement（PLAN_STEP_LIMIT=60，常量与语义见 workunit.types.ts）。到线不走
  // recordResult 的强制收口 in_review（plan 已从中豁免）——前置守卫在此转
  // need_input 挂 blocked 转人，不静默截断；人回复即续期（waiting-input 给
  // planStepAllowance 加一份 PLAN_STEP_LIMIT，复活回 active 续跑）。
  if (wu.type === 'plan') {
    const allowance = typeof metadata.planStepAllowance === 'number' && Number.isFinite(metadata.planStepAllowance) && metadata.planStepAllowance > 0
      ? Math.floor(metadata.planStepAllowance)
      : PLAN_STEP_LIMIT;
    const planSteps = metadata.stepCount ?? 0;
    if (planSteps >= allowance) {
      logger.warn('[AgentLoop] Plan step limit reached — suspending for human decision', {
        workUnitId: wu.id, stepCount: planSteps, allowance,
      });
      return {
        result: {
          action: 'need_input' as const,
          summary: `这次规划已推进 ${planSteps} 步，达到为它设定的步数额度 ${allowance}，已暂停等你决定。回复任意内容（或「继续」）即续期 ${PLAN_STEP_LIMIT} 步接着跑；想收尾可在 Web 端点「通过」进入人工确认`,
          metadataUpdates: { waitingReason: 'plan-step-limit' },
        },
      };
    }
  }

  return { result: null };
}
