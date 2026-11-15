/**
 * D16 聚合核心纯函数（工单 30 自 metrics.service.ts 纯函数区抽出，纯搬运零逻辑变更）：
 * 快照 + WU 事件 + 统一事件 + 人类消息 → 指标组（含 F6 evidence 组），
 * 供 MetricsService 与单测直接调用；口径原则：数据不足 → 显式 0 / null，不编造。
 * 2026-10-17：aggregateOverview 各指标组平移至 metrics-overview.ts，本文件保留原导出面。
 */

import { parseStudioEventPayload, getStudioEventTime } from '@dommaker/studio-shared';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';
import type { AssigneeProfileResolver } from '../workunit/index.js';
import type {
  CacheHitRateMetrics,
  StepCacheHitRate,
  SectionTrimMetrics,
  ContextComparisonMetrics,
  ContextModeMetrics,
} from './metrics.types.js';
import { DEFAULT_WINDOW_DAYS } from './metrics-overview.js';

export { aggregateOverview, DEFAULT_WINDOW_DAYS } from './metrics-overview.js';
export type { OverviewAggregateInput } from './metrics-overview.js';

// ─── #120 验证指标三件套之 1、2：输入缓存命中率 + 段 trim 率 ───

export interface CacheHitRateAggregateInput {
  events: Array<Record<string, unknown>>;
  /** 角色归因用：workUnitId → assigneeId */
  snapshots: WorkUnitSnapshot[];
  resolveAssigneeProfile: AssigneeProfileResolver;
  profileNames: Map<string, string>;
  now: number;
  windowDays?: number;
}

/** 命中率 = ΣcacheRead / Σ(input + cacheRead)；分母 0 → null（不编造） */
function hitRatePct(cacheRead: number, input: number): number | null {
  return input + cacheRead > 0 ? Math.round((cacheRead / (input + cacheRead)) * 100) : null;
}

/**
 * #120 输入缓存命中率聚合（纯事件流，不新建采集）。
 * 口径：cacheReadTokens / (inputTokens + cacheReadTokens)，逐事件累加再相除（非逐事件取均值）。
 * 维度：步（每个带缓存字段的事件一个数据点）/ WU / 角色（workUnitId→assigneeId→profileId，同 tokens.byRole）/ 天（createdAt YYYY-MM-DD）。
 * 仅当事件同时带 inputTokens 与 cacheReadTokens（CLI 回报 usage）才计入命中率；其余事件只进覆盖率分母。
 */
export function aggregateCacheHitRate(input: CacheHitRateAggregateInput): CacheHitRateMetrics {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = input.now;
  const windowStart = now - windowDays * 86400_000;
  const inWindow = (ts: number) => Number.isFinite(ts) && ts >= windowStart && ts <= now + 60_000;
  const wuById = new Map(input.snapshots.map(s => [s.id, s] as [string, WorkUnitSnapshot]));

  let totalCacheRead = 0;
  let totalInput = 0;
  let tokenEvents = 0;
  let coverageEvents = 0;
  const workUnitIds = new Set<string>();
  const steps: StepCacheHitRate[] = [];
  const byDayMap = new Map<string, { cacheReadTokens: number; inputTokens: number; events: number }>();
  const byWuMap = new Map<string, { cacheReadTokens: number; inputTokens: number; events: number }>();
  const byRoleMap = new Map<string, { profileId: string; cacheReadTokens: number; inputTokens: number; events: number }>();

  for (const row of input.events) {
    if (row?.type !== 'workunit:tokens') continue;
    if (!inWindow(getStudioEventTime(row))) continue;
    tokenEvents++;
    const payload = parseStudioEventPayload(row);
    if (!payload) continue;
    const inputTokens = typeof payload.inputTokens === 'number' && Number.isFinite(payload.inputTokens) ? payload.inputTokens : null;
    const cacheReadTokens = typeof payload.cacheReadTokens === 'number' && Number.isFinite(payload.cacheReadTokens) ? payload.cacheReadTokens : null;
    if (inputTokens === null || cacheReadTokens === null) continue; // CLI 未回报 usage → 不进命中率口径

    coverageEvents++;
    totalInput += inputTokens;
    totalCacheRead += cacheReadTokens;
    const wuId = typeof payload.workUnitId === 'string' ? payload.workUnitId : null;
    const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
    const createdAt = typeof row.createdAt === 'string' && row.createdAt ? row.createdAt : new Date(getStudioEventTime(row)).toISOString();

    if (wuId) workUnitIds.add(wuId);
    steps.push({
      executionId,
      workUnitId: wuId,
      createdAt,
      inputTokens,
      cacheReadTokens,
      hitRatePct: hitRatePct(cacheReadTokens, inputTokens),
    });

    const day = createdAt.slice(0, 10);
    const dayB = byDayMap.get(day) ?? { cacheReadTokens: 0, inputTokens: 0, events: 0 };
    dayB.cacheReadTokens += cacheReadTokens;
    dayB.inputTokens += inputTokens;
    dayB.events++;
    byDayMap.set(day, dayB);

    if (wuId) {
      const wuB = byWuMap.get(wuId) ?? { cacheReadTokens: 0, inputTokens: 0, events: 0 };
      wuB.cacheReadTokens += cacheReadTokens;
      wuB.inputTokens += inputTokens;
      wuB.events++;
      byWuMap.set(wuId, wuB);

      const profileId = input.resolveAssigneeProfile(wuById.get(wuId)?.assigneeId);
      if (profileId) {
        const roleB = byRoleMap.get(profileId) ?? { profileId, cacheReadTokens: 0, inputTokens: 0, events: 0 };
        roleB.cacheReadTokens += cacheReadTokens;
        roleB.inputTokens += inputTokens;
        roleB.events++;
        byRoleMap.set(profileId, roleB);
      }
    }
  }

  const toBucket = (b: { cacheReadTokens: number; inputTokens: number; events: number }) => ({
    cacheReadTokens: b.cacheReadTokens,
    inputTokens: b.inputTokens,
    hitRatePct: hitRatePct(b.cacheReadTokens, b.inputTokens),
    events: b.events,
  });

  return {
    description: '输入缓存命中率：cacheRead / (input + cacheRead)。高 = prompt 缓存吃上了、重复上下文白花 token 少；段序重排（#119）前后对比该指标验证重排收益（重排前先用现序跑一次基线）。',
    windowDays,
    overall: {
      ...toBucket({ cacheReadTokens: totalCacheRead, inputTokens: totalInput, events: coverageEvents }),
      workUnits: workUnitIds.size,
    },
    steps,
    byWorkUnit: [...byWuMap.entries()]
      .map(([workUnitId, b]) => ({ workUnitId, ...toBucket(b) }))
      .sort((a, b) => b.events - a.events || b.cacheReadTokens - a.cacheReadTokens),
    byRole: [...byRoleMap.entries()]
      .map(([profileId, b]) => ({ profileId, profileName: input.profileNames.get(profileId) ?? profileId, ...toBucket(b) }))
      .sort((a, b) => b.events - a.events || b.cacheReadTokens - a.cacheReadTokens),
    byDay: [...byDayMap.entries()]
      .map(([day, b]) => ({ day, ...toBucket(b) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    coveragePct: tokenEvents > 0 ? Math.round((coverageEvents / tokenEvents) * 100) : 0,
    source: tokenEvents > 0 ? 'events' : 'insufficient-data',
  };
}

export interface SectionTrimAggregateInput {
  events: Array<Record<string, unknown>>;
  now: number;
  windowDays?: number;
}

/**
 * #120 段 trim 率聚合（纯事件流）。
 * 口径：prompt:section_trimmed 事件按 payload.section 动态分桶（不硬编码段清单，兼容 #119 段序重排后新增契约段）。
 * 每段统计 trim 事件数 + 平均原始/裁剪后尺寸 + 平均裁减比例 mean((original-trimmed)/original)。
 * 「trim 率 = trim 次数 / 组装次数」需要组装计数埋点，暂缺 → 最简口径为「按段 trim 计数 + 平均尺寸」。
 */
export function aggregateSectionTrim(input: SectionTrimAggregateInput): SectionTrimMetrics {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = input.now;
  const windowStart = now - windowDays * 86400_000;
  const inWindow = (ts: number) => Number.isFinite(ts) && ts >= windowStart && ts <= now + 60_000;

  const bySection = new Map<string, { section: string; trimCount: number; originalSum: number; trimmedSum: number; trimRatioSum: number }>();
  let totalOriginal = 0;
  let totalTrimmed = 0;
  let trimEvents = 0;

  for (const row of input.events) {
    if (row?.type !== 'prompt:section_trimmed') continue;
    if (!inWindow(getStudioEventTime(row))) continue;
    const payload = parseStudioEventPayload(row);
    if (!payload) continue;
    const section = typeof payload.section === 'string' && payload.section ? payload.section : 'unknown';
    const original = typeof payload.originalTokens === 'number' && Number.isFinite(payload.originalTokens) ? payload.originalTokens : 0;
    const trimmed = typeof payload.trimmedTokens === 'number' && Number.isFinite(payload.trimmedTokens) ? payload.trimmedTokens : 0;

    trimEvents++;
    totalOriginal += original;
    totalTrimmed += trimmed;
    const b = bySection.get(section) ?? { section, trimCount: 0, originalSum: 0, trimmedSum: 0, trimRatioSum: 0 };
    b.trimCount++;
    b.originalSum += original;
    b.trimmedSum += trimmed;
    b.trimRatioSum += original > 0 ? (original - trimmed) / original : 0;
    bySection.set(section, b);
  }

  return {
    description: '段 trim 率：prompt 注入段被分段软定额截断的次数与尺寸（按段）。某段 trim 频繁且裁减比例高 = 该段内容膨胀或定额偏紧，需校准定额或精简内容源。',
    windowDays,
    bySection: [...bySection.values()]
      .map(b => ({
        section: b.section,
        trimCount: b.trimCount,
        avgOriginalTokens: Math.round(b.originalSum / b.trimCount),
        avgTrimmedTokens: Math.round(b.trimmedSum / b.trimCount),
        avgTrimPct: Math.round((b.trimRatioSum / b.trimCount) * 100),
      }))
      .sort((a, b) => b.trimCount - a.trimCount || b.avgOriginalTokens - a.avgOriginalTokens),
    totals: { trimEvents, totalOriginalTokens: totalOriginal, totalTrimmedTokens: totalTrimmed },
    source: trimEvents > 0 ? 'events' : 'insufficient-data',
  };
}

export interface ContextComparisonAggregateInput {
  events: Array<Record<string, unknown>>;
  now: number;
  windowDays?: number;
}

interface ContextBucket {
  steps: number;
  presentedTokens: number;
  repeatedTokens: number;
  overflows: number;
  recoveryAttempts: number;
  recoverySucceeded: number;
  humanInputsAfterRecovery: number;
  succeededSteps: number;
  completedSteps: number;
  failedSteps: number;
}

function emptyContextBucket(): ContextBucket {
  return {
    steps: 0, presentedTokens: 0, repeatedTokens: 0, overflows: 0,
    recoveryAttempts: 0, recoverySucceeded: 0, humanInputsAfterRecovery: 0,
    succeededSteps: 0, completedSteps: 0, failedSteps: 0,
  };
}

function contextNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function finalizeContextBucket(bucket: ContextBucket): ContextModeMetrics {
  const terminalSteps = bucket.completedSteps + bucket.failedSteps;
  const totalTokens = bucket.presentedTokens + bucket.repeatedTokens;
  const { failedSteps: _, ...counters } = bucket;
  return {
    ...counters,
    repeatedTokenPct: totalTokens > 0 ? Math.round((bucket.repeatedTokens / totalTokens) * 100) : 0,
    successRatePct: bucket.steps > 0 ? Math.round((bucket.succeededSteps / bucket.steps) * 100) : null,
    completionRatePct: terminalSteps > 0 ? Math.round((bucket.completedSteps / terminalSteps) * 100) : null,
  };
}

/** #714：同一执行步事件流按 full/delta 分桶；质量门只报告证据，不自动改环境开关。 */
export function aggregateContextComparison(input: ContextComparisonAggregateInput): ContextComparisonMetrics {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowStart = input.now - windowDays * 86400_000;
  const buckets = { full: emptyContextBucket(), delta: emptyContextBucket() };
  let samples = 0;

  for (const row of input.events) {
    if (row?.type !== 'workunit:execution_step') continue;
    const at = getStudioEventTime(row);
    if (!Number.isFinite(at) || at < windowStart || at > input.now + 60_000) continue;
    const payload = parseStudioEventPayload(row);
    if (!payload) continue;
    const context = payload.context as Record<string, unknown> | undefined;
    const mode = context?.mode;
    if (!context || (mode !== 'full' && mode !== 'delta')) continue;
    const bucket = buckets[mode];
    samples++;
    bucket.steps++;
    bucket.presentedTokens += contextNumber(context.presentedTokens);
    bucket.repeatedTokens += contextNumber(context.repeatedTokens);
    if (payload.contextOverflow === true) bucket.overflows++;
    if (payload.status === 'success') bucket.succeededSteps++;
    if (payload.status === 'failed') bucket.failedSteps++;
    if (payload.action === 'complete') bucket.completedSteps++;
    const recoveredFrom = payload.recoveredFrom;
    const recovery = recoveredFrom === 'full' || recoveredFrom === 'delta'
      || context.recovery === true;
    if (recovery) {
      const recoveryBucket = recoveredFrom === 'full' || recoveredFrom === 'delta'
        ? buckets[recoveredFrom]
        : bucket;
      recoveryBucket.recoveryAttempts++;
      if (payload.status === 'success') recoveryBucket.recoverySucceeded++;
      recoveryBucket.humanInputsAfterRecovery += contextNumber(context.humanInputs);
    }
  }

  const full = finalizeContextBucket(buckets.full);
  const delta = finalizeContextBucket(buckets.delta);
  const hasQualitySamples = full.steps > 0 && delta.steps > 0
    && full.completionRatePct !== null && delta.completionRatePct !== null;
  const qualityNotRegressed = hasQualitySamples
    ? delta.successRatePct! >= full.successRatePct!
      && delta.completionRatePct! >= full.completionRatePct!
    : null;
  return {
    description: 'full/delta 执行步对照：重复段 token、上下文溢出、新会话恢复、恢复后人类输入（人工重述代理）及步/完成成功率。两组均有质量样本且 delta 不回归才允许人工扩大启用。',
    windowDays,
    full,
    delta,
    qualityNotRegressed,
    rolloutEligible: qualityNotRegressed === true,
    source: samples > 0 ? 'events' : 'insufficient-data',
  };
}
