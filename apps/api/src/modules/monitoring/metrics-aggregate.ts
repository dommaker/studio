/**
 * D16 聚合核心纯函数（工单 30 自 metrics.service.ts 纯函数区抽出，纯搬运零逻辑变更）：
 * 快照 + WU 事件 + 统一事件 + 人类消息 → 九组指标（含 F6 evidence 组），
 * 供 MetricsService 与单测直接调用；口径原则：数据不足 → 显式 0 / null，不编造。
 */

import { deriveDisplayState, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { parseStudioEventPayload, getStudioEventTime } from '../../utils/studio-events.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import type { AssigneeProfileResolver } from '../workunit/assignee-resolver.js';
import type {
  TaskFlowMetrics,
  IntakeMetrics,
  HumanInterventionMetrics,
  CycleTimeMetrics,
  RoleMetrics,
  QualityMetrics,
  TokenMetrics,
  AlertMetrics,
  EvidenceMetrics,
  OverviewMetrics,
  CacheHitRateMetrics,
  StepCacheHitRate,
  SectionTrimMetrics,
} from './metrics.types.js';

export const DEFAULT_WINDOW_DAYS = 7;
/** 告警近 24h 窗口（信噪比基础数据） */
const ALERT_24H_MS = 24 * 3600_000;
/** 非终态状态（滞留时长统计对象） */
const NON_TERMINAL = new Set(['unassigned', 'active', 'in_review', 'blocked']);

// ─── 纯函数聚合（供 service 与单测直接调用）──

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

function percentile(values: number[]): { p50: number | null; p95: number | null } {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: pick(0.5), p95: pick(0.95) };
}

const msToHours = (ms: number) => Math.round((ms / 3600_000) * 10) / 10;

function parseMeta(metadata: string | null): Record<string, any> {
  return parseWuMetadata(metadata);
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

  // ── F6 证据台账（决策 1）：全快照口径（非窗口），派生一律过 deriveDisplayState ──
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
  const evidence: EvidenceMetrics = {
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
    evidence,
    source: hasData ? 'events' : 'insufficient-data',
  };
}

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
