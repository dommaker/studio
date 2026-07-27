/**
 * D16 监控指标聚合（B5）— 任务流健康 / 入口转化 / 人工干预 / 周期 / 角色 / 工程质量 / Token / 告警。
 *
 * 数据源（全部文件型，无数据库）：
 *   - FileStore workunits/index.json（状态机快照 + metadata）
 *   - FileStore workunits/events.jsonl（created/claimed/completed/blocked/updated 事件）
 *   - 统一事件文件（D18: ~/.studio/logs/studio-events.jsonl；workunit:tokens、monitor:alert）
 *   - 频道 messages.jsonl（authorType=human，经 FileStore.queryAllMessages）
 *
 * 窗口默认 7d（opts.windowDays 可调）；60s 内存缓存防连打。
 * 口径原则：数据不足 → 显式 0 / null + source='insufficient-data'，不编造。
 * 每个指标组带 description（大白话：这个数高了/低了意味着什么）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { readStudioEvents, parseStudioEventPayload, getStudioEventTime } from '../../utils/studio-events.js';

/** D16: 聚合缓存（60s——要扫 index + 多个 jsonl，避免连打） */
const CACHE_TTL_MS = 60_000;

const DEFAULT_WINDOW_DAYS = 7;
/** 告警近 24h 窗口（信噪比基础数据） */
const ALERT_24H_MS = 24 * 3600_000;
/** 非终态状态（滞留时长统计对象） */
const NON_TERMINAL = new Set(['unassigned', 'active', 'in_review', 'blocked']);

// ─── 类型 ───

export interface Percentile {
  count: number;
  /** P50（小时，1 位小数；无数据 → null） */
  p50Hours: number | null;
  /** P95（小时，1 位小数；无数据 → null） */
  p95Hours: number | null;
}

export interface TaskFlowMetrics {
  description: string;
  /** 各状态 WU 数（当前快照） */
  byStatus: Record<string, number>;
  /** 非终态 WU 滞留时长（now - updatedAt） */
  dwell: Percentile & { description: string };
  /** 创建→认领时长（窗口内创建且已认领） */
  createToClaim: Percentile & { description: string };
  /** 认领→完成时长（窗口内完成） */
  claimToComplete: Percentile & { description: string };
  /** 失败按 errorType 分桶（窗口内更新过、failureType 列或 metadata.errorType 非空） */
  failuresByErrorType: { description: string; buckets: Record<string, number> };
  /** 执行步数统计（窗口内更新过且 metadata.stepCount > 0） */
  steps: { description: string; count: number; avgStepCount: number | null; stuckWorkUnits: number; avgStuckSteps: number | null };
}

export interface IntakeMetrics {
  description: string;
  /** 窗口内频道人类消息数（authorType=human） */
  humanMessages: number;
  /** 窗口内创建的 WU 数（workunits events created） */
  workUnitsCreated: number;
  /** 转化率 %（created/humanMessages；无消息 → null 不编造） */
  conversionPct: number | null;
}

export interface HumanInterventionMetrics {
  description: string;
  /** 窗口内完成的 WU 数（分母） */
  completedWorkUnits: number;
  /** NEED_INPUT 挂起次数（blocked 事件 metadata.waitingForInput；澄清期/执行期拆分见 roles） */
  needInputCount: number;
  /** review 驳回次数（完成 WU metadata._consecutiveReviewRejections 累计；含 dispatcher 自动驳回，数据源无法区分） */
  reviewRejections: number;
  /** 合并冲突转人工次数（完成 WU metadata.mergeConflict） */
  mergeConflicts: number;
  /** 北极星：每完成 WU 的平均人工干预次数；无完成 → null 不编造 */
  avgPerCompletedWu: number | null;
}

export interface CycleTimeMetrics {
  description: string;
  /** WU 创建→done 端到端时长（窗口内完成） */
  createToDone: Percentile;
  avgHours: number | null;
}

export interface RoleMetrics {
  description: string;
  roles: Array<{
    profileId: string;
    profileName: string;
    /** 窗口内认领数（claimed 事件归因） */
    claims: number;
    /** 窗口内完成数（completed 快照归因） */
    completions: number;
    /** 平均执行时长（小时，认领→完成；无 → null） */
    avgDurationHours: number | null;
    /** NEED_INPUT 次数：澄清期（waitingReason='ownership'，开工前问归属） */
    needInputClarify: number;
    /** NEED_INPUT 次数：执行期（执行中 agent 提问） */
    needInputExecution: number;
  }>;
}

export interface QualityMetrics {
  description: string;
  /** 自动验证通过数（窗口内更新、metadata.verifyReport 存在） */
  verifyPassed: number;
  /** 验证连续失败未通过数（verifyFailCount>0 且无 verifyReport） */
  verifyFailing: number;
  /** verifyReport 通过率 %（passed/(passed+failing)；无数据 → null） */
  verifyPassRatePct: number | null;
  /** 窗口内合并冲突转人工数（metadata.mergeConflict） */
  mergeConflicts: number;
  /** 窗口内完成自动合并数（metadata.mergedAt 落在窗口内） */
  merges: number;
}

export interface TokenMetrics {
  description: string;
  /** 窗口内合计 */
  totals: { injectedTokens: number; executionTokens: number; totalTokens: number };
  /** 有 token 事件归因的去重 WU 数 */
  workUnits: number;
  /** 每 WU 平均 token（executionTotals/workUnits；无 → null） */
  avgTokensPerWu: number | null;
  /** 缓存命中率 %（ΣcacheRead / Σ(cacheRead+cacheCreation+input)；无缓存数据 → null） */
  cacheHitRatePct: number | null;
  /** 缓存数据覆盖率（带 cache 字段的事件占比 %；<100 说明命中率为部分口径） */
  cacheCoveragePct: number;
  /** 按角色聚合（归因链同 token-usage.service：workUnitId → assigneeId → roleId） */
  byRole: Array<{ profileId: string; profileName: string; injectedTokens: number; executionTokens: number; totalTokens: number; workUnits: number }>;
}

export interface AlertMetrics {
  description: string;
  /** 近 24h 告警数（信噪比基础数据） */
  last24h: number;
  /** 窗口内告警数 */
  inWindow: number;
  /** 窗口内按级别分桶（payload.level） */
  byLevel: Record<string, number>;
}

export interface OverviewMetrics {
  windowDays: number;
  generatedAt: string;
  taskFlow: TaskFlowMetrics;
  intake: IntakeMetrics;
  humanIntervention: HumanInterventionMetrics;
  cycleTime: CycleTimeMetrics;
  roles: RoleMetrics;
  quality: QualityMetrics;
  tokens: TokenMetrics;
  alerts: AlertMetrics;
  /** 数据源状态：有任何 WU 或事件数据 → 'events'，全空 → 'insufficient-data' */
  source: 'events' | 'insufficient-data';
}

// ─── 纯函数聚合（供 service 与单测直接调用）──

export interface OverviewAggregateInput {
  snapshots: WorkUnitSnapshot[];
  wuEvents: WorkUnitEvent[];
  /** 统一事件文件行（D18） */
  events: Array<Record<string, unknown>>;
  /** 频道人类消息（authorType=human；只需 createdAt） */
  humanMessages: Array<{ createdAt?: string }>;
  /** instanceId → profileId */
  instanceToProfile: Map<string, string>;
  /** profileId → name */
  profileNames: Map<string, string>;
  now: number;
  windowDays?: number;
}

function percentile(values: number[]): { p50: number | null; p95: number | null } {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: pick(0.5), p95: pick(0.95) };
}

const msToHours = (ms: number) => Math.round((ms / 3600_000) * 10) / 10;

function parseMeta(metadata: string | null): Record<string, any> {
  if (!metadata) return {};
  try { return JSON.parse(metadata) as Record<string, any>; } catch { return {}; }
}

export function aggregateOverview(input: OverviewAggregateInput): OverviewMetrics {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = input.now;
  const windowStart = now - windowDays * 86400_000;
  const inWindow = (ts: number) => Number.isFinite(ts) && ts >= windowStart && ts <= now + 60_000;
  const iso = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);

  const metas = new Map<string, Record<string, any>>();
  for (const s of input.snapshots) metas.set(s.id, parseMeta(s.metadata));
  const wuById = new Map(input.snapshots.map(s => [s.id, s] as [string, WorkUnitSnapshot]));

  // ── 任务流健康 ──
  const byStatus: Record<string, number> = {};
  const dwellValues: number[] = [];
  for (const s of input.snapshots) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (NON_TERMINAL.has(s.status)) {
      const updated = iso(s.updatedAt);
      if (Number.isFinite(updated) && updated <= now) dwellValues.push(now - updated);
    }
  }

  const createToClaimValues: number[] = [];
  const claimToCompleteValues: number[] = [];
  const createToDoneValues: number[] = [];
  const failureBuckets: Record<string, number> = {};
  const stepCounts: number[] = [];
  const stuckCounts: number[] = [];
  const completedSnapshots: WorkUnitSnapshot[] = [];

  for (const s of input.snapshots) {
    const created = iso(s.createdAt);
    const claimed = iso(s.claimedAt);
    const completed = iso(s.completedAt);
    const updated = iso(s.updatedAt);
    const meta = metas.get(s.id)!;

    if (inWindow(created) && Number.isFinite(claimed) && Number.isFinite(created) && claimed >= created) {
      createToClaimValues.push(claimed - created);
    }
    if (inWindow(completed) && Number.isFinite(claimed) && Number.isFinite(completed) && completed >= claimed) {
      claimToCompleteValues.push(completed - claimed);
    }
    if (inWindow(completed) && Number.isFinite(created) && completed >= created) {
      createToDoneValues.push(completed - created);
      completedSnapshots.push(s);
    } else if (inWindow(completed)) {
      completedSnapshots.push(s);
    }

    if (inWindow(updated)) {
      const errorType = s.failureType ?? (typeof meta.errorType === 'string' && meta.errorType ? meta.errorType : null);
      if (errorType) failureBuckets[errorType] = (failureBuckets[errorType] ?? 0) + 1;
      if (typeof meta.stepCount === 'number' && meta.stepCount > 0) stepCounts.push(meta.stepCount);
      if (typeof meta.consecutiveStuck === 'number' && meta.consecutiveStuck > 0) stuckCounts.push(meta.consecutiveStuck);
    }
  }

  const dwellP = percentile(dwellValues);
  const c2cP = percentile(createToClaimValues);
  const cl2dP = percentile(claimToCompleteValues);
  const c2dP = percentile(createToDoneValues);

  const taskFlow: TaskFlowMetrics = {
    description: '任务流健康：WU 在各状态的堆积与流转速度。滞留 P95 高 = 有任务卡住没人管；创建→认领高 = 接单慢；认领→完成高 = 执行慢；errorType 分桶暴露主要失败原因。',
    byStatus,
    dwell: {
      description: '非终态 WU 在当前状态的滞留时长（按 updatedAt 近似）。P95 高 = 尾部任务卡住',
      count: dwellValues.length,
      p50Hours: dwellP.p50 !== null ? msToHours(dwellP.p50) : null,
      p95Hours: dwellP.p95 !== null ? msToHours(dwellP.p95) : null,
    },
    createToClaim: {
      description: '窗口内创建的 WU 从创建到被认领的时长。高 = agent 接单不及时（调度/容量问题）',
      count: createToClaimValues.length,
      p50Hours: c2cP.p50 !== null ? msToHours(c2cP.p50) : null,
      p95Hours: c2cP.p95 !== null ? msToHours(c2cP.p95) : null,
    },
    claimToComplete: {
      description: '窗口内完成的 WU 从认领到完成的时长。高 = 单次执行慢（任务太大或反复返工）',
      count: claimToCompleteValues.length,
      p50Hours: cl2dP.p50 !== null ? msToHours(cl2dP.p50) : null,
      p95Hours: cl2dP.p95 !== null ? msToHours(cl2dP.p95) : null,
    },
    failuresByErrorType: {
      description: '窗口内更新过的 WU 按失败类型分桶（failureType 列优先，其次 metadata.errorType）。某桶高 = 该类失败是主要瓶颈',
      buckets: failureBuckets,
    },
    steps: {
      description: 'WU 平均执行步数（metadata.stepCount）与当前连续无进展步数（consecutiveStuck）。步数异常高或 stuck WU 多 = agent 在空转',
      count: stepCounts.length,
      avgStepCount: stepCounts.length > 0 ? Math.round((stepCounts.reduce((a, b) => a + b, 0) / stepCounts.length) * 10) / 10 : null,
      stuckWorkUnits: stuckCounts.length,
      avgStuckSteps: stuckCounts.length > 0 ? Math.round((stuckCounts.reduce((a, b) => a + b, 0) / stuckCounts.length) * 10) / 10 : null,
    },
  };

  // ── 入口转化 ──
  const humanMessageCount = input.humanMessages.filter(m => inWindow(iso(m.createdAt))).length;
  const createdCount = input.wuEvents.filter(e => e.type === 'created' && inWindow(iso(e.timestamp))).length;
  const intake: IntakeMetrics = {
    description: '入口转化：频道里人发的消息有多少真正变成了任务（WU）。转化率低 = 消息被静默丢弃（路由没识别、没人接单建任务），这是最容易被忽视的漏单点',
    humanMessages: humanMessageCount,
    workUnitsCreated: createdCount,
    conversionPct: humanMessageCount > 0 ? Math.round((createdCount / humanMessageCount) * 100) : null,
  };

  // ── 人工干预（北极星）──
  let needInputCount = 0;
  const needInputByWu = new Map<string, { clarify: number; execution: number }>();
  for (const e of input.wuEvents) {
    if (e.type !== 'blocked' || !inWindow(iso(e.timestamp))) continue;
    const dataMeta = parseMeta(typeof (e.data as any)?.metadata === 'string' ? (e.data as any).metadata : null);
    if (dataMeta.waitingForInput !== true) continue;
    needInputCount++;
    const bucket = needInputByWu.get(e.wuId) ?? { clarify: 0, execution: 0 };
    if (dataMeta.waitingReason === 'ownership') bucket.clarify++;
    else bucket.execution++;
    needInputByWu.set(e.wuId, bucket);
  }

  let reviewRejections = 0;
  let mergeConflictsCompleted = 0;
  for (const s of completedSnapshots) {
    const meta = metas.get(s.id)!;
    if (typeof meta._consecutiveReviewRejections === 'number') reviewRejections += meta._consecutiveReviewRejections;
    if (meta.mergeConflict === true) mergeConflictsCompleted++;
  }

  const interventionTotal = needInputCount + reviewRejections + mergeConflictsCompleted;
  const humanIntervention: HumanInterventionMetrics = {
    description: '北极星：每完成一个 WU 平均要人介入几次（NEED_INPUT 答复 + review 驳回 + 合并冲突处理）。越低越自治；高 = agent 频繁卡壳等人救场。注：review 驳回含 dispatcher 自动驳回，数据源无法区分人工/自动',
    completedWorkUnits: completedSnapshots.length,
    needInputCount,
    reviewRejections,
    mergeConflicts: mergeConflictsCompleted,
    avgPerCompletedWu: completedSnapshots.length > 0
      ? Math.round((interventionTotal / completedSnapshots.length) * 100) / 100
      : null,
  };

  // ── 端到端周期 ──
  const cycleTime: CycleTimeMetrics = {
    description: '端到端周期：WU 从创建到 done 的总时长（窗口内完成）。P50 是典型体感，P95 是尾部风险；P95 远高于 P50 = 少数任务拖很久',
    createToDone: {
      count: createToDoneValues.length,
      p50Hours: c2dP.p50 !== null ? msToHours(c2dP.p50) : null,
      p95Hours: c2dP.p95 !== null ? msToHours(c2dP.p95) : null,
    },
    avgHours: createToDoneValues.length > 0
      ? msToHours(createToDoneValues.reduce((a, b) => a + b, 0) / createToDoneValues.length)
      : null,
  };

  // ── 角色维度 ──
  const roleAgg = new Map<string, {
    claims: number; completions: number; durations: number[];
    needInputClarify: number; needInputExecution: number;
  }>();
  const roleOfWu = (wuId: string): string | null => {
    const s = wuById.get(wuId);
    if (!s?.assigneeId) return null;
    return input.instanceToProfile.get(s.assigneeId) ?? null;
  };
  const roleEntry = (profileId: string) => {
    let e = roleAgg.get(profileId);
    if (!e) {
      e = { claims: 0, completions: 0, durations: [], needInputClarify: 0, needInputExecution: 0 };
      roleAgg.set(profileId, e);
    }
    return e;
  };

  for (const e of input.wuEvents) {
    if (e.type !== 'claimed' || !inWindow(iso(e.timestamp))) continue;
    // claimed 事件的 data 携带 assigneeId
    const assigneeId = typeof (e.data as any)?.assigneeId === 'string' ? (e.data as any).assigneeId
      : input.snapshots.find(x => x.id === e.wuId)?.assigneeId;
    const profileId = assigneeId ? input.instanceToProfile.get(assigneeId) : null;
    if (profileId) roleEntry(profileId).claims++;
  }
  for (const s of completedSnapshots) {
    const profileId = s.assigneeId ? input.instanceToProfile.get(s.assigneeId) : null;
    if (!profileId) continue;
    const entry = roleEntry(profileId);
    entry.completions++;
    const claimed = iso(s.claimedAt);
    const completed = iso(s.completedAt);
    if (Number.isFinite(claimed) && Number.isFinite(completed) && completed >= claimed) {
      entry.durations.push(completed - claimed);
    }
  }
  for (const [wuId, buckets] of needInputByWu) {
    const profileId = roleOfWu(wuId);
    if (!profileId) continue;
    const entry = roleEntry(profileId);
    entry.needInputClarify += buckets.clarify;
    entry.needInputExecution += buckets.execution;
  }

  const roles: RoleMetrics = {
    description: '角色维度：每个角色的接单/完成/执行时长与提问次数。澄清期提问多 = 任务下发信息不全；执行期提问多 = 角色能力或上下文不足；某角色时长显著高 = 该类任务或该角色有瓶颈',
    roles: [...roleAgg.entries()]
      .map(([profileId, e]) => ({
        profileId,
        profileName: input.profileNames.get(profileId) ?? profileId,
        claims: e.claims,
        completions: e.completions,
        avgDurationHours: e.durations.length > 0
          ? msToHours(e.durations.reduce((a, b) => a + b, 0) / e.durations.length)
          : null,
        needInputClarify: e.needInputClarify,
        needInputExecution: e.needInputExecution,
      }))
      .sort((a, b) => b.completions - a.completions || b.claims - a.claims),
  };

  // ── 工程质量 ──
  let verifyPassed = 0;
  let verifyFailing = 0;
  let mergeConflicts = 0;
  let merges = 0;
  for (const s of input.snapshots) {
    const updated = iso(s.updatedAt);
    if (!inWindow(updated)) continue;
    const meta = metas.get(s.id)!;
    if (meta.verifyReport) verifyPassed++;
    else if (typeof meta.verifyFailCount === 'number' && meta.verifyFailCount > 0) verifyFailing++;
    if (meta.mergeConflict === true) mergeConflicts++;
    if (typeof meta.mergedAt === 'string' && inWindow(iso(meta.mergedAt))) merges++;
  }
  const verifyTotal = verifyPassed + verifyFailing;
  const quality: QualityMetrics = {
    description: '工程质量：自动验证通过率、合并冲突数、自动合并成功数。通过率低或冲突多 = 产物质量差、返工多；merges 高 = 无人值守交付链路在工作',
    verifyPassed,
    verifyFailing,
    verifyPassRatePct: verifyTotal > 0 ? Math.round((verifyPassed / verifyTotal) * 100) : null,
    mergeConflicts,
    merges,
  };

  // ── Token ──
  const tokenTotals = { injectedTokens: 0, executionTokens: 0, totalTokens: 0 };
  const tokenWuIds = new Set<string>();
  const roleTokens = new Map<string, { injectedTokens: number; executionTokens: number; totalTokens: number; wuIds: Set<string> }>();
  let cacheRead = 0;
  let cacheCreation = 0;
  let cacheInput = 0;
  let cacheEvents = 0;
  let execEvents = 0;

  for (const row of input.events) {
    if (row?.type !== 'workunit:tokens') continue;
    if (!inWindow(getStudioEventTime(row))) continue;
    const payload = parseStudioEventPayload(row);
    if (!payload) continue;
    const wuId = typeof payload.workUnitId === 'string' ? payload.workUnitId : null;
    const injected = typeof payload.injectedTokens === 'number' && Number.isFinite(payload.injectedTokens) ? payload.injectedTokens : 0;
    const execution = typeof payload.executionTokens === 'number' && Number.isFinite(payload.executionTokens) ? payload.executionTokens : 0;
    const total = typeof payload.totalTokens === 'number' && Number.isFinite(payload.totalTokens) ? payload.totalTokens : injected + execution;

    tokenTotals.injectedTokens += injected;
    tokenTotals.executionTokens += execution;
    tokenTotals.totalTokens += total;
    execEvents++;

    if (typeof payload.cacheReadTokens === 'number' || typeof payload.cacheCreationTokens === 'number' || typeof payload.inputTokens === 'number') {
      cacheEvents++;
      cacheRead += typeof payload.cacheReadTokens === 'number' ? payload.cacheReadTokens : 0;
      cacheCreation += typeof payload.cacheCreationTokens === 'number' ? payload.cacheCreationTokens : 0;
      cacheInput += typeof payload.inputTokens === 'number' ? payload.inputTokens : 0;
    }

    if (wuId) {
      tokenWuIds.add(wuId);
      const wu = wuById.get(wuId);
      const profileId = wu?.assigneeId ? input.instanceToProfile.get(wu.assigneeId) : null;
      if (profileId) {
        let rt = roleTokens.get(profileId);
        if (!rt) {
          rt = { injectedTokens: 0, executionTokens: 0, totalTokens: 0, wuIds: new Set() };
          roleTokens.set(profileId, rt);
        }
        rt.injectedTokens += injected;
        rt.executionTokens += execution;
        rt.totalTokens += total;
        rt.wuIds.add(wuId);
      }
    }
  }

  const cacheDenominator = cacheRead + cacheCreation + cacheInput;
  const tokens: TokenMetrics = {
    description: 'Token 消耗：按角色归因（归因链同 token-usage.service，无法归因的不计入 byRole 但计入 totals）。每 WU 平均 token 高 = 单任务成本失控；缓存命中率低 = prompt 缓存没吃上、重复上下文白花 token',
    totals: tokenTotals,
    workUnits: tokenWuIds.size,
    avgTokensPerWu: tokenWuIds.size > 0 ? Math.round(tokenTotals.executionTokens / tokenWuIds.size) : null,
    cacheHitRatePct: cacheDenominator > 0 ? Math.round((cacheRead / cacheDenominator) * 100) : null,
    cacheCoveragePct: execEvents > 0 ? Math.round((cacheEvents / execEvents) * 100) : 0,
    byRole: [...roleTokens.entries()]
      .map(([profileId, rt]) => ({
        profileId,
        profileName: input.profileNames.get(profileId) ?? profileId,
        injectedTokens: rt.injectedTokens,
        executionTokens: rt.executionTokens,
        totalTokens: rt.totalTokens,
        workUnits: rt.wuIds.size,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  };

  // ── 告警 ──
  const alertLevels: Record<string, number> = {};
  let alerts24h = 0;
  let alertsInWindow = 0;
  for (const row of input.events) {
    if (row?.type !== 'monitor:alert') continue;
    const ts = getStudioEventTime(row);
    if (!Number.isFinite(ts)) continue;
    if (ts >= now - ALERT_24H_MS && ts <= now + 60_000) alerts24h++;
    if (inWindow(ts)) {
      alertsInWindow++;
      const payload = parseStudioEventPayload(row);
      const level = typeof payload?.level === 'string' ? payload.level : 'unknown';
      alertLevels[level] = (alertLevels[level] ?? 0) + 1;
    }
  }
  const alerts: AlertMetrics = {
    description: '告警量：近 24h 与窗口内 monitor:alert 数（按级别分桶）。24h 告警持续很高 = 告警太吵（信噪比差，真告警会被淹没）；长期为 0 也不一定健康 = 探测可能没跑',
    last24h: alerts24h,
    inWindow: alertsInWindow,
    byLevel: alertLevels,
  };

  const hasData = input.snapshots.length > 0 || input.wuEvents.length > 0 || input.events.length > 0;
  return {
    windowDays,
    generatedAt: new Date(now).toISOString(),
    taskFlow,
    intake,
    humanIntervention,
    cycleTime,
    roles,
    quality,
    tokens,
    alerts,
    source: hasData ? 'events' : 'insufficient-data',
  };
}

// ─── Service（数据加载 + 60s 缓存）──

export interface OverviewOptions {
  windowDays?: number;
  /** 测试注入：统一事件文件路径（默认 D18 统一文件） */
  eventsFile?: string;
  /** 测试注入：workunits events.jsonl 路径（默认 FileStore 数据目录下） */
  wuEventsFile?: string;
  /** 测试注入时钟（提供时跳过缓存） */
  now?: number;
}

export class MetricsService {
  private fileStore: FileStore;
  private cache = new Map<string, { at: number; data: OverviewMetrics }>();

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  /** 测试/调试用：清空缓存 */
  invalidateCache(): void {
    this.cache.clear();
  }

  private defaultWuEventsFile(): string {
    return path.join(os.homedir(), '.studio', 'data', 'workunits', 'events.jsonl');
  }

  async getOverviewMetrics(opts?: OverviewOptions): Promise<OverviewMetrics> {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const now = opts?.now ?? Date.now();
    const cacheKey = `${opts?.eventsFile ?? ''}|${opts?.wuEventsFile ?? ''}|${windowDays}`;
    if (!opts?.now) {
      const hit = this.cache.get(cacheKey);
      if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
    }

    const [snapshots, wuEvents, events, humanMessages, states, profiles] = await Promise.all([
      this.fileStore.getIndex().catch(() => [] as WorkUnitSnapshot[]),
      this.fileStore.readJsonl<WorkUnitEvent>(opts?.wuEventsFile ?? this.defaultWuEventsFile()).catch(() => [] as WorkUnitEvent[]),
      readStudioEvents({ file: opts?.eventsFile }),
      this.fileStore.queryAllMessages({ authorType: 'human' }).catch(() => [] as Array<{ createdAt?: string }>),
      this.fileStore.listStates().catch(() => [] as Array<{ id: string; roleId: string }>),
      this.fileStore.listProfiles().catch(() => [] as Array<{ id: string; name: string }>),
    ]);

    const instanceToProfile = new Map<string, string>();
    for (const s of states) if (s?.id && s?.roleId) instanceToProfile.set(s.id, s.roleId);
    const profileNames = new Map<string, string>();
    for (const p of profiles) if (p?.id) profileNames.set(p.id, p.name);

    const data = aggregateOverview({
      snapshots,
      wuEvents,
      events,
      humanMessages,
      instanceToProfile,
      profileNames,
      now,
      windowDays,
    });

    if (!opts?.now) this.cache.set(cacheKey, { at: now, data });
    return data;
  }
}
