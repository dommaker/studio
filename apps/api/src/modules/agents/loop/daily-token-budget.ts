/**
 * C3（2026-08-03 unattended-token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。
 *
 * 背景：无人值守期间 daemon 触发器链路 3 天烧掉 1.03 亿 token，期间无任何机制阻止
 * 消耗失控（无每日预算、无超限告警）。本模块提供最后一道全局安全阀：
 *
 *   - 当日已耗 ≥ 预算（默认 2M token/日，STUDIO_DAILY_TOKEN_BUDGET 覆盖，<=0 关闭）
 *     → agent-loop 不再起会话，WU 转 need_input 挂起（等次日本地零点预算复位或人工处置）。
 *   - 超限当日全局只告警一次（notifyAlert：告警频道 + 企业微信），并落
 *     `studio:budget-tripped` 事件留痕 —— 进程重启后扫描该事件恢复 notified，
 *     不会重复告警。
 *
 * 用量口径：workunit:tokens 事件的 `billedTokens ?? totalTokens`（B6 起 billed 含
 * cache_read/cache_creation，是账单口径；旧事件无 billed 字段退回 totalTokens，
 * 多算一点注入估算，方向上是保守的）。
 *
 * 性能：事件文件可达十几 MB，不能每 step 全量扫。进程内维护当日计数器 ——
 * 仅首次检查/跨天边界全量扫一次（bootstrap），之后由 writeWorkunitTokenEvent
 * 落盘时经 noteTokensWritten 累加。best-effort：其他进程写入的事件不计入计数器，
 * 靠进程重启/跨天重扫收敛（对 2M 量级的熔断足够）。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { notifyAlert } from '../../../utils/notifier.js';

/** 默认每日预算：2M token（billed 口径）——决策记录 #4 与用户确认的阈值 */
export const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;

/** 熔断留痕事件类型（notified 持久化标记 + 事后审计） */
export const BUDGET_TRIPPED_EVENT = 'studio:budget-tripped';

const fileStore = new FileStore();

/**
 * 熔断守卫开关：默认仅生产/开发进程启用；测试环境（NODE_ENV=test / VITEST）默认关闭
 * （与 B2 守卫同约定——仓库自身单测驱动 loop 不应被预算拦截）；
 * STUDIO_TOKEN_BUDGET_GUARD=on/off 显式覆盖。
 */
export function tokenBudgetGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STUDIO_TOKEN_BUDGET_GUARD === 'on') return true;
  if (env.STUDIO_TOKEN_BUDGET_GUARD === 'off') return false;
  return env.NODE_ENV !== 'test' && !env.VITEST;
}

/** 每日预算（token 数）：STUDIO_DAILY_TOKEN_BUDGET 覆盖；非法值回落默认；<=0 = 不熔断 */
export function resolveDailyTokenBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STUDIO_DAILY_TOKEN_BUDGET?.trim();
  if (!raw) return DEFAULT_DAILY_TOKEN_BUDGET;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAILY_TOKEN_BUDGET;
  return Math.floor(n);
}

/** 本地自然日 key（与 token-usage.service 的 sameLocalDay 同口径：本地时区） */
function localDateKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

interface DailyBudgetState {
  eventsFile: string;
  dateKey: string;
  usedTokens: number;
  /** 当日是否已告警（含从 budget-tripped 事件扫描恢复的） */
  notified: boolean;
}

/** 进程内当日计数器；换文件/跨天自动作废重扫 */
let state: DailyBudgetState | null = null;

/** 测试用：清空进程内预算状态 */
export function resetDailyTokenBudgetState(): void {
  state = null;
}

export interface DailyTokenUsage {
  dateKey: string;
  usedTokens: number;
  notified: boolean;
}

/**
 * 当日已耗查询。进程内计数器命中（同文件同日）直接返回；
 * 否则全量扫一次事件文件 bootstrap（同日过滤求和 + 检测 budget-tripped 留痕）。
 * 文件不存在/不可读/行损坏 → 按 0 计，绝不抛错。
 */
export async function getDailyTokenUsage(opts: { eventsFile: string; now?: number }): Promise<DailyTokenUsage> {
  const now = opts.now ?? Date.now();
  const dateKey = localDateKey(now);
  if (state && state.eventsFile === opts.eventsFile && state.dateKey === dateKey) {
    return { dateKey, usedTokens: state.usedTokens, notified: state.notified };
  }

  let usedTokens = 0;
  let notified = false;
  try {
    const rows = await fileStore.readJsonl<Record<string, unknown>>(opts.eventsFile);
    for (const row of rows) {
      const tsRaw = (row.createdAt ?? row.timestamp) as string | undefined;
      const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
      if (!Number.isFinite(ts) || localDateKey(ts) !== dateKey) continue;
      if (row.type === 'workunit:tokens') {
        let payload: Record<string, unknown>;
        try {
          payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>) ?? {};
        } catch {
          continue; // 撕裂/损坏行跳过，不编造
        }
        const billed = typeof payload.billedTokens === 'number' && Number.isFinite(payload.billedTokens)
          ? payload.billedTokens : null;
        const total = typeof payload.totalTokens === 'number' && Number.isFinite(payload.totalTokens)
          ? payload.totalTokens : null;
        usedTokens += billed ?? total ?? 0;
      } else if (row.type === BUDGET_TRIPPED_EVENT) {
        notified = true;
      }
    }
  } catch {
    // 事件文件不存在/不可读 → 全零
  }

  state = { eventsFile: opts.eventsFile, dateKey, usedTokens, notified };
  return { dateKey, usedTokens, notified };
}

/**
 * 记账钩子：workunit:tokens 事件落盘成功后累加进程内计数器（由 agent-loop 的
 * writeWorkunitTokenEvent 调用；tokens 口径与扫描一致 = billed ?? total）。
 * 未 bootstrap / 换文件 / 跨天边界 → 跳过（下次 getDailyTokenUsage 重扫收敛）。
 */
export function noteTokensWritten(eventsFile: string, tokens: number, now: number = Date.now()): void {
  if (!state || state.eventsFile !== eventsFile) return;
  if (state.dateKey !== localDateKey(now)) return;
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  state.usedTokens += tokens;
}

/**
 * 当日首次熔断告警：落 budget-tripped 事件（notified 持久化 + 审计留痕）+
 * notifyAlert 通知出口（告警频道 + 企业微信）。fire-and-forget 语义：写盘/通知
 * 失败仅记日志，绝不抛给调用方阻断流程。
 */
export async function notifyBudgetTripped(opts: {
  eventsFile: string;
  usedTokens: number;
  budget: number;
  now?: number;
}): Promise<void> {
  const now = opts.now ?? Date.now();
  const dateKey = localDateKey(now);
  if (state && state.eventsFile === opts.eventsFile && state.dateKey === dateKey) {
    state.notified = true;
  }
  try {
    await fileStore.appendJsonl(opts.eventsFile, {
      type: BUDGET_TRIPPED_EVENT,
      source: 'agent-loop',
      payload: JSON.stringify({ dateKey, usedTokens: opts.usedTokens, budget: opts.budget }),
      createdAt: new Date(now).toISOString(),
    });
  } catch (err) {
    logger.warn('[Budget] budget-tripped event write failed (non-blocking)', { error: String(err) });
  }
  await notifyAlert(
    'critical',
    '[Budget] 每日 token 预算熔断',
    `当日已消耗 ${opts.usedTokens.toLocaleString()} / 预算 ${opts.budget.toLocaleString()} token`
      + '（billed 口径，含 cache_read）。自动执行已暂停：后续任务逐个转 need_input 挂起，'
      + '次日本地零点预算复位。如需当日恢复：调高 STUDIO_DAILY_TOKEN_BUDGET 并重启服务。',
  );
}
