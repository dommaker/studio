// AgentLoop agentStep 前置守卫（B2 测试特征 WU 关闭 / C3 每日 token 预算熔断）——
// 从 agent-loop.ts agentStep 原样抽出，行为不变。
import { logger } from '@dommaker/studio-shared';
import { type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import {
  tokenBudgetGuardEnabled, resolveDailyTokenBudget, getDailyTokenUsage,
  notifyBudgetTripped,
} from './daily-token-budget.js';
import { testWuGuardEnabled, isTestLikeWorkUnit } from './wu-test-guards.js';
import { studioEventsJsonlPath } from './workunit-token-events.js';
import { postToDiscussionSpace, type RecordResultDeps } from './agent-loop-record-result.js';
import type { StepResult } from './agent-output-parser.js';

/** agentStep 前置守卫：命中守卫时返回 StepResult（agentStep 提前返回），否则返回 null 继续执行 */
export async function evaluatePreStepGuards(deps: RecordResultDeps, wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<StepResult | null> {
  // B2 守卫（2026-08-03 token-burn issue P0-1c）：测试特征 WU 不起会话、直接关闭。
  // 历史事故：路由测试经共享数据根把测试 WU 写进生产 FileStore，daemon 当真任务逐个
  // 起 Claude 会话执行（16 个会话 420 万 token）。关闭留痕 testWorkUnitGuard + blockReason。
  if (testWuGuardEnabled() && isTestLikeWorkUnit(wu, metadata)) {
    logger.warn('[AgentLoop] Test-like WorkUnit guarded — closing without execution', {
      workUnitId: wu.id, scope: wu.scope,
    });
    await deps.workUnitService.update(wu.id, {
      metadata: { ...metadata, testWorkUnitGuard: true, blockReason: 'test-wu-guard: 测试特征任务，守卫关闭' },
    }).catch(err => logger.warn('[AgentLoop] test-wu guard metadata write failed', { workUnitId: wu.id, error: String(err) }));
    if (wu.status !== 'closed') {
      await deps.workUnitService.transitionStatus(wu.id, 'closed')
        .catch(err => logger.warn('[AgentLoop] test-wu guard close failed', { workUnitId: wu.id, error: String(err) }));
    }
    await postToDiscussionSpace(deps, wu.id, '检测到测试特征任务，已跳过执行并关闭（防止测试数据空烧 token）')
      .catch(() => {});
    return { action: 'skipped', summary: '' };
  }

  // C3 守卫（2026-08-03 token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。
  // 当日 billed 口径消耗 ≥ 预算（默认 2M/日，STUDIO_DAILY_TOKEN_BUDGET 覆盖，<=0 关闭）→
  // 不起会话，WU 经 need_input 挂起（recordResult 落 waitingForInput + blockReason），
  // 等次日本地零点预算复位或人工处置；全局当日只告警一次（studio:budget-tripped 事件留痕）。
  // 用量走进程内计数器（daily-token-budget），仅首次/跨天全量扫一次事件文件，不拖慢热路径。
  if (tokenBudgetGuardEnabled()) {
    const dailyBudget = resolveDailyTokenBudget();
    if (dailyBudget > 0) {
      const eventsFile = studioEventsJsonlPath();
      const daily = await getDailyTokenUsage({ eventsFile });
      if (daily.usedTokens >= dailyBudget) {
        logger.warn('[AgentLoop] Daily token budget tripped — pausing automatic execution', {
          workUnitId: wu.id, usedTokens: daily.usedTokens, budget: dailyBudget,
        });
        if (!daily.notified) {
          await notifyBudgetTripped({ eventsFile, usedTokens: daily.usedTokens, budget: dailyBudget });
        }
        return {
          action: 'need_input' as const,
          summary: `每日 token 预算已熔断（当日已用 ${daily.usedTokens.toLocaleString()} / 上限 ${dailyBudget.toLocaleString()}，billed 口径含 cache_read）：已暂停自动执行、不再起会话。次日（本地零点）预算复位后回复任意内容继续，或直接关闭任务`,
        };
      }
    }
  }
  return null;
}
