import { deriveDisplayState, POOL_STAGNATION_WARN_MS, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { parseStudioEventPayload, getStudioEventTime, percentile } from '@dommaker/studio-shared';
import { parseWuMetadata } from '../workunit/index.js';
import type { AssigneeProfileResolver } from '../workunit/index.js';
import type {
  TaskFlowMetrics,
  IntakeMetrics,
  HumanInterventionMetrics,
  CycleTimeMetrics,
  RoleMetrics,
  QualityMetrics,
  TokenMetrics,
  AlertMetrics,
  StuckMetrics,
  Failure24hMetrics,
  EvidenceMetrics,
  OverviewMetrics,
} from './metrics.types.js';

export const DEFAULT_WINDOW_DAYS = 7;
/** 告警近 24h 窗口（信噪比基础数据） */
const ALERT_24H_MS = 24 * 3600_000;
/** 非终态状态（滞留时长统计对象） */
const NON_TERMINAL = new Set(['unassigned', 'active', 'in_review', 'blocked']);

export interface OverviewAggregateInput {
  snapshots: WorkUnitSnapshot[];
  wuEvents: WorkUnitEvent[];
  /** 统一事件文件行（D18） */
  events: Array<Record<string, unknown>>;
  /** 频道人类消息（authorType=human；只需 createdAt） */
  humanMessages: Array<{ createdAt?: string }>;
  /** assigneeId → profileId 双语义解析（workunit/assignee-resolver；实例反查 + profile-id 直通） */
  resolveAssigneeProfile: AssigneeProfileResolver;
  /** profileId → name */
  profileNames: Map<string, string>;
  now: number;
  windowDays?: number;
}

/** p50/p95 对（线性插值 type 7，正本 @dommaker/studio-shared percentile）；空样本显式 null（口径：数据不足 → null，不编造） */
function percentilePair(values: number[]): { p50: number | null; p95: number | null } {
  if (values.length === 0) return { p50: null, p95: null };
  return { p50: percentile(values, 50), p95: percentile(values, 95) };
}

const msToHours = (ms: number) => Math.round((ms / 3600_000) * 10) / 10;

function parseMeta(metadata: string | null): Record<string, any> {
  return parseWuMetadata(metadata);
}

interface OverviewContext {
  input: OverviewAggregateInput;
  windowDays: number;
  now: number;
  inWindow: (ts: number) => boolean;
  iso: (s: string | null | undefined) => number;
  metas: Map<string, Record<string, any>>;
  wuById: Map<string, WorkUnitSnapshot>;
  byStatus: Record<string, number>;
  dwellValues: number[];
  createToClaimValues: number[];
  claimToCompleteValues: number[];
  createToDoneValues: number[];
  failureBuckets: Record<string, number>;
  stepCounts: number[];
  stuckCounts: number[];
  completedSnapshots: WorkUnitSnapshot[];
  dwellP: { p50: number | null; p95: number | null };
  c2cP: { p50: number | null; p95: number | null };
  cl2dP: { p50: number | null; p95: number | null };
  c2dP: { p50: number | null; p95: number | null };
}

function buildOverviewContext(input: OverviewAggregateInput): OverviewContext {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = input.now;
  const windowStart = now - windowDays * 86400_000;
  const inWindow = (ts: number) => Number.isFinite(ts) && ts >= windowStart && ts <= now + 60_000;
  const iso = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);

  const metas = new Map<string, Record<string, any>>();
  for (const s of input.snapshots) metas.set(s.id, parseMeta(s.metadata));
  const wuById = new Map(input.snapshots.map(s => [s.id, s] as [string, WorkUnitSnapshot]));

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

  return {
    input,
    windowDays,
    now,
    inWindow,
    iso,
    metas,
    wuById,
    byStatus,
    dwellValues,
    createToClaimValues,
    claimToCompleteValues,
    createToDoneValues,
    failureBuckets,
    stepCounts,
    stuckCounts,
    completedSnapshots,
    dwellP: percentilePair(dwellValues),
    c2cP: percentilePair(createToClaimValues),
    cl2dP: percentilePair(claimToCompleteValues),
    c2dP: percentilePair(createToDoneValues),
  };
}

function aggregateTaskFlow(ctx: OverviewContext): TaskFlowMetrics {
  const {
    byStatus, dwellValues, createToClaimValues, claimToCompleteValues,
    failureBuckets, stepCounts, stuckCounts, dwellP, c2cP, cl2dP,
  } = ctx;
  return {
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
}

function aggregateIntake(ctx: OverviewContext): IntakeMetrics {
  const { input, inWindow, iso } = ctx;
  const humanMessageCount = input.humanMessages.filter(m => inWindow(iso(m.createdAt))).length;
  const createdCount = input.wuEvents.filter(e => e.type === 'created' && inWindow(iso(e.timestamp))).length;
  return {
    description: '入口转化：频道里人发的消息有多少真正变成了任务（WU）。转化率低 = 消息被静默丢弃（路由没识别、没人接单建任务），这是最容易被忽视的漏单点',
    humanMessages: humanMessageCount,
    workUnitsCreated: createdCount,
    conversionPct: humanMessageCount > 0 ? Math.round((createdCount / humanMessageCount) * 100) : null,
  };
}

interface NeedInputSamples {
  needInputCount: number;
  needInputByWu: Map<string, { clarify: number; execution: number }>;
}

function collectNeedInputSamples(ctx: OverviewContext): NeedInputSamples {
  const { input, inWindow, iso } = ctx;
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
  return { needInputCount, needInputByWu };
}

function aggregateHumanIntervention(
  ctx: OverviewContext,
  samples: NeedInputSamples,
): HumanInterventionMetrics {
  const { completedSnapshots, metas } = ctx;
  const { needInputCount } = samples;
  let reviewRejections = 0;
  let mergeConflictsCompleted = 0;
  for (const s of completedSnapshots) {
    const meta = metas.get(s.id)!;
    if (typeof meta._consecutiveReviewRejections === 'number') reviewRejections += meta._consecutiveReviewRejections;
    if (meta.mergeConflict === true) mergeConflictsCompleted++;
  }

  const interventionTotal = needInputCount + reviewRejections + mergeConflictsCompleted;
  return {
    description: '北极星：每完成一个 WU 平均要人介入几次（NEED_INPUT 答复 + review 驳回 + 合并冲突处理）。越低越自治；高 = agent 频繁卡壳等人救场。注：review 驳回含 dispatcher 自动驳回，数据源无法区分人工/自动',
    completedWorkUnits: completedSnapshots.length,
    needInputCount,
    reviewRejections,
    mergeConflicts: mergeConflictsCompleted,
    avgPerCompletedWu: completedSnapshots.length > 0
      ? Math.round((interventionTotal / completedSnapshots.length) * 100) / 100
      : null,
  };
}

function aggregateCycleTime(ctx: OverviewContext): CycleTimeMetrics {
  const { createToDoneValues, c2dP } = ctx;
  return {
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
}

function aggregateRoles(ctx: OverviewContext, samples: NeedInputSamples): RoleMetrics {
  const { input, inWindow, iso, completedSnapshots, wuById } = ctx;
  const { needInputByWu } = samples;
  const roleAgg = new Map<string, {
    claims: number; completions: number; durations: number[];
    needInputClarify: number; needInputExecution: number;
  }>();
  const roleOfWu = (wuId: string): string | null => {
    const s = wuById.get(wuId);
    return input.resolveAssigneeProfile(s?.assigneeId);
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
    const profileId = input.resolveAssigneeProfile(assigneeId);
    if (profileId) roleEntry(profileId).claims++;
  }
  for (const s of completedSnapshots) {
    const profileId = input.resolveAssigneeProfile(s.assigneeId);
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

  return {
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
}

function aggregateQuality(ctx: OverviewContext): QualityMetrics {
  const { input, inWindow, iso, metas } = ctx;
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
  return {
    description: '工程质量：自动验证通过率、合并冲突数、自动合并成功数。通过率低或冲突多 = 产物质量差、返工多；merges 高 = 无人值守交付链路在工作',
    verifyPassed,
    verifyFailing,
    verifyPassRatePct: verifyTotal > 0 ? Math.round((verifyPassed / verifyTotal) * 100) : null,
    mergeConflicts,
    merges,
  };
}

function aggregateTokens(ctx: OverviewContext): TokenMetrics {
  const { input, inWindow, wuById } = ctx;
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
      const profileId = input.resolveAssigneeProfile(wu?.assigneeId);
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
  return {
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
}

function aggregateAlerts(ctx: OverviewContext): AlertMetrics {
  const { input, now, inWindow } = ctx;
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
  return {
    description: '告警量：近 24h 与窗口内 monitor:alert 数（按级别分桶）。24h 告警持续很高 = 告警太吵（信噪比差，真告警会被淹没）；长期为 0 也不一定健康 = 探测可能没跑',
    last24h: alerts24h,
    inWindow: alertsInWindow,
    byLevel: alertLevels,
  };
}

function aggregateStuck(ctx: OverviewContext): StuckMetrics {
  const { input, now, iso } = ctx;
  // stuck 纯快照派生，无窗口概念；口径与前端原 loadStuck 一致
  let stuckBlocked = 0;
  let staleUnassigned = 0;
  let stalledActive = 0;
  for (const s of input.snapshots) {
    if (s.status === 'blocked') stuckBlocked++;
    else if (s.status === 'unassigned') {
      const created = iso(s.createdAt);
      if (Number.isFinite(created) && now - created > POOL_STAGNATION_WARN_MS) staleUnassigned++;
    } else if (s.status === 'active') {
      const timeout = iso(s.timeoutAt);
      if (Number.isFinite(timeout) && timeout < now) stalledActive++;
    }
  }
  return {
    description: '卡住计数：blocked 总数 / 待领取滞留（创建超 2h 没人接，对齐 #181 池滞留探针）/ 执行中停滞（租约过期 = loop 失联）。非零 = 有任务需要人介入',
    blocked: stuckBlocked,
    staleUnassigned,
    stalledActive,
  };
}

function aggregateFailure24h(ctx: OverviewContext): Failure24hMetrics {
  const { input, now } = ctx;
  // failure24h：口径复刻前端原 loadFailures（#181 失败趋势探针）——workunit:failed 终态 +
  // 失败执行步；历史步事件缺 status 按 success（#172）；48h 下限自带（旧前端靠 since 查询参数过滤）
  const cutoff24 = now - 24 * 3600_000;
  const cutoff48 = now - 48 * 3600_000;
  let rFailed = 0, rSuccess = 0, pFailed = 0, pSuccess = 0;
  for (const row of input.events) {
    if (row?.type !== 'workunit:execution_step' && row?.type !== 'workunit:failed') continue;
    const payload = row.type === 'workunit:execution_step' ? parseStudioEventPayload(row) : null;
    // 非法 payload 的步事件跳过（对齐前端原口径），不计成功也不计失败
    if (row.type === 'workunit:execution_step' && !payload) continue;
    let ts = getStudioEventTime(row);
    if (!Number.isFinite(ts) && payload) {
      const at = (payload as Record<string, unknown>).at;
      ts = typeof at === 'string' ? new Date(at).getTime() : NaN;
    }
    if (!Number.isFinite(ts) || ts < cutoff48) continue;
    const recent = ts >= cutoff24;
    if (row.type === 'workunit:failed') {
      if (recent) rFailed++; else pFailed++;
    } else if (payload?.status === 'failed') {
      if (recent) rFailed++; else pFailed++;
    } else {
      if (recent) rSuccess++; else pSuccess++;
    }
  }
  const failureRate = (f: number, s: number) => (f + s > 0 ? f / (f + s) : null);
  const rRate = failureRate(rFailed, rSuccess);
  const pRate = failureRate(pFailed, pSuccess);
  return {
    description: '近 24h 失败趋势：失败次数（WU 失败终态 + 失败执行步）与失败率，并与前 24h 比方向。持续 up = 执行链路在退化（模型/环境/任务拆分问题）',
    n: rFailed,
    rate: rRate,
    trend: rRate !== null && pRate !== null
      ? rRate > pRate ? 'up' : rRate < pRate ? 'down' : 'flat'
      : null,
  };
}

function aggregateEvidence(ctx: OverviewContext): EvidenceMetrics {
  const { input } = ctx;
  let engaged = 0;
  let l1Approved = 0;
  let l2Approved = 0;
  let l3Approved = 0;
  let selfReviewCount = 0;
  let needsHuman = 0;
  let derivedMismatch = 0;
  const derivedByColumn: Record<string, number> = {};
  for (const s of input.snapshots) {
    const d = deriveDisplayState({ status: s.status, metadata: s.metadata });
    derivedByColumn[d.column] = (derivedByColumn[d.column] ?? 0) + 1;
    if (d.column !== s.status) derivedMismatch++;
    if (!d.hasAttestations) {
      if (s.status === 'in_review') needsHuman++; // 手写 in_review 本来就在人工队列
      continue;
    }
    engaged++;
    if (d.evidence.l1) l1Approved++;
    if (d.evidence.l2) l2Approved++;
    if (d.evidence.l3) l3Approved++;
    if (d.evidence.selfReview) selfReviewCount++;
    if (d.needsHuman) needsHuman++;
  }
  return {
    description: 'F6 证据台账：l1 自动验证 / l2 agent 评审 / l3 人工确认的分层达成数（快照口径）。selfReviewCount 高 = 评审独立性不足；needsHuman = 等人工确认的队列长度；derivedMismatch 是双轨比对——派生列与存储状态不一致的 WU 数，持续为 0 才可停止手写 in_review',
    engaged,
    l1Approved,
    l2Approved,
    l3Approved,
    selfReviewCount,
    needsHuman,
    derivedMismatch,
    derivedByColumn,
  };
}

export function aggregateOverview(input: OverviewAggregateInput): OverviewMetrics {
  const ctx = buildOverviewContext(input);
  const taskFlow = aggregateTaskFlow(ctx);
  const intake = aggregateIntake(ctx);
  const needInputSamples = collectNeedInputSamples(ctx);
  const humanIntervention = aggregateHumanIntervention(ctx, needInputSamples);
  const cycleTime = aggregateCycleTime(ctx);
  const roles = aggregateRoles(ctx, needInputSamples);
  const quality = aggregateQuality(ctx);
  const tokens = aggregateTokens(ctx);
  const alerts = aggregateAlerts(ctx);
  const stuck = aggregateStuck(ctx);
  const failure24h = aggregateFailure24h(ctx);
  const evidence = aggregateEvidence(ctx);

  const hasData = input.snapshots.length > 0 || input.wuEvents.length > 0 || input.events.length > 0;
  return {
    windowDays: ctx.windowDays,
    generatedAt: new Date(ctx.now).toISOString(),
    taskFlow,
    intake,
    humanIntervention,
    cycleTime,
    roles,
    quality,
    tokens,
    alerts,
    stuck,
    failure24h,
    evidence,
    source: hasData ? 'events' : 'insufficient-data',
  };
}
