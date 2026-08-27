/**
 * knowledge-metrics — KnowledgeService 的 Measure 能力带（飞轮度量 / 健康 / 审计 / 准确度）。
 *
 * 从 knowledge-service.ts 抽出的纯函数模块（工单 29，纯搬运不改逻辑）：
 * 本模块函数均不依赖 KnowledgeService 实例，store 数据以参数传入；
 * KnowledgeService 的五个 Measure 方法（getFlywheelMetrics/getHealthReport/
 * getAuditReport/getAnalystAccuracy/getStats）仅做薄封装。
 */

import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
// #342：窗口读口（尾部倒读 + 窗口外早停）——事件流扫描切到此读口
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');

// ── Measure types ──

export interface FlywheelMetrics {
  quality: number;
  hitRate: number;
  improvement: number;
  freshness: number;
  timestamp: string;
  /**
   * R1: 事件衍生指标（hitRate/improvement）的数据来源标记。
   * 'events' = 滚动窗口内有 outcome 事件，指标为实算；
   * 'insufficient-data' = 窗口内无 outcome 事件（或读取失败），hitRate/improvement 为 0 占位而非编造。
   * quality/freshness 始终由 KnowledgeStore 实算，不受此标记影响。
   */
  source?: 'events' | 'insufficient-data';
}

export interface HealthReport {
  score: number;
  totalEntries: number;
  staleEntries: number;
  orphanEntries: number;
  duplicateEntries: number;
  timestamp: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  trend: string;
  timestamp: string;
  /** M1: 事件流计数（滚动窗口，默认 30 天）。窗口内无任何相关事件 → 计数为显式 0 且 source='insufficient-data'（不编造）。 */
  eventCounts: {
    windowDays: number;
    /** knowledge:consumption 事件数（lifecycle recordReference 驱动的消费记录） */
    consumption: number;
    /** knowledge:outcome:success 事件数 */
    outcomeSuccess: number;
    /** knowledge:outcome:failure 事件数 */
    outcomeFailure: number;
    /** knowledge:extraction 事件数（R3 LLM 提取） */
    extraction: number;
    source: 'events' | 'insufficient-data';
  };
  /** M1: 知识库条目按成熟度分布（store 实算，数据源恒为 store） */
  entries: {
    total: number;
    byMaturity: Record<string, number>;
    source: 'store';
  };
  /**
   * M1: 引用次数最多的条目（top 5）。
   * 数据源 = store 条目的 referencedBy 计数（harness KnowledgeLifecycle.recordReference 维护；
   * 注意 recordReference 并不维护 ~/.studio/knowledge/.consumption-stats.json —— 该文件是
   * monitor.service 写的每日聚合摘要 {date,dailyEvents,searchHits}，不含条目级数据）。
   */
  topReferenced: Array<{ id: string; title: string; references: number }>;
  /** M1: 近 30 天 LLM 提取活动（knowledge:extraction 事件实算） */
  extractionActivity: {
    count: number;
    totalTokens: number;
    lastAt: string | null;
    source: 'events' | 'insufficient-data';
  };
}

export interface AuditFinding {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  entryId?: string;
}

export interface AccuracyData {
  analystId: string;
  prediction: string;
  actual: string;
  accurate: boolean;
  timestamp: string;
}

/**
 * M1 诚实契约：系统中不存在 analyst 预测 vs 实际结果的结构化数据源
 * （recordAnalystAccuracy 仅被知识总线旧壳/测试引用，生产无调用方），
 * 因此 getAnalystAccuracy 返回 available:false + reason，而不是假空 stub。
 * 若未来接入真实数据源，返回 available:true 并填充度量字段。
 */
export interface AccuracyReport {
  available: boolean;
  reason?: string;
  overallAccuracy?: number;
  byAnalyst?: Record<string, number>;
  recentPredictions?: AccuracyData[];
  timestamp: string;
}

// ── store 分区实算（getFlywheelMetrics / getHealthReport / getAuditReport 的薄封装内核） ──

/** getFlywheelMetrics 的 store 分区：quality（成熟度加权）+ freshness（30 天引用率）。 */
export function computeFlywheelStoreMetrics(entries: any[]): { quality: number; freshness: number } {
  const total = entries.length;
  let quality = 0;
  let freshness = 0;
  if (total > 0) {
    // Quality: weighted maturity score (proven=3, verified=2, draft=1)
    const maturityWeight: Record<string, number> = { proven: 3, verified: 2, active: 1.5, draft: 1, deprecated: 0, archived: 0 };
    const qualitySum = entries.reduce((s: number, e: any) => s + (maturityWeight[e.maturity] || 0), 0);
    quality = Math.min(100, Math.round((qualitySum / (total * 3)) * 100));

    // Freshness: % referenced in last 30 days
    const now = Date.now();
    const recentCount = entries.filter((e: any) =>
      e.lastReferenced && (now - new Date(e.lastReferenced).getTime()) < 30 * 86400000
    ).length;
    freshness = Math.round((recentCount / total) * 100);
  }
  return { quality, freshness };
}

/** getHealthReport 的成功路径：由 store 条目实算健康分。 */
export function computeHealthReport(entries: any[]): HealthReport {
  const total = entries.length;
  const now = Date.now();
  const staleThreshold = 30 * 86400000; // 30 days
  const staleEntries = entries.filter((e: any) =>
    !e.lastReferenced || (now - new Date(e.lastReferenced).getTime()) > staleThreshold
  ).length;
  const score = total === 0 ? 0 : Math.round(((total - staleEntries) / total) * 100);
  return {
    score,
    totalEntries: total,
    staleEntries,
    orphanEntries: 0,
    duplicateEntries: 0,
    timestamp: new Date().toISOString(),
  };
}

/** getHealthReport 的兜底：store 读取失败时返回显式 0。 */
export function emptyHealthReport(): HealthReport {
  return { score: 0, totalEntries: 0, staleEntries: 0, orphanEntries: 0, duplicateEntries: 0, timestamp: new Date().toISOString() };
}

/** getAuditReport 的 store 分区（恒有数据源）：成熟度分布 + top referenced。 */
export function computeAuditStorePartition(all: any[]): { entries: AuditReport['entries']; topReferenced: AuditReport['topReferenced'] } {
  const byMaturity: Record<string, number> = {};
  for (const e of all) {
    const m = (e as any).maturity ?? 'unknown';
    byMaturity[m] = (byMaturity[m] || 0) + 1;
  }
  const entries: AuditReport['entries'] = { total: all.length, byMaturity, source: 'store' };
  const topReferenced = all
    .map((e: any) => ({
      id: e.id,
      title: typeof e.title === 'string' ? e.title.slice(0, 80) : '',
      references: Array.isArray(e.referencedBy) ? e.referencedBy.length : 0,
    }))
    .filter(t => t.references > 0)
    .sort((a, b) => b.references - a.references)
    .slice(0, 5);
  return { entries, topReferenced };
}

/**
 * trend：复用 outcome 成功率前后半窗口对比（与 getFlywheelMetrics.improvement 同一定义）。
 */
export function deriveOutcomeTrend(outcomes: Array<{ ts: number; success: boolean }>, windowDays: number): string {
  let trend = 'insufficient-data';
  if (outcomes.length > 0) {
    const now = Date.now();
    const windowStart = now - windowDays * 86400000;
    const midpoint = windowStart + (now - windowStart) / 2;
    const firstHalf = outcomes.filter(o => o.ts < midpoint);
    const secondHalf = outcomes.filter(o => o.ts >= midpoint);
    if (firstHalf.length > 0 && secondHalf.length > 0) {
      const sr1 = firstHalf.filter(o => o.success).length / firstHalf.length;
      const sr2 = secondHalf.filter(o => o.success).length / secondHalf.length;
      trend = sr2 > sr1 ? 'improving' : sr2 < sr1 ? 'declining' : 'stable';
    } else {
      trend = 'stable'; // 单边窗口无法比势，记 stable（有事件但趋势不可算）
    }
  }
  return trend;
}

/** findings：从实算数据派生，不预造。 */
export function buildAuditFindings(input: {
  entries: AuditReport['entries'];
  stats: { eventCounts: AuditReport['eventCounts'] };
  windowDays: number;
}): AuditFinding[] {
  const { entries, stats, windowDays } = input;
  const findings: AuditFinding[] = [];
  if (entries.total === 0) {
    findings.push({ type: 'empty-store', severity: 'medium', description: '知识库无任何条目' });
  }
  const drafts = entries.byMaturity['draft'] ?? 0;
  if (drafts > 0) {
    findings.push({
      type: 'proposals-pending-review', severity: 'low',
      description: `${drafts} 条 proposal 待人工审核（maturity=draft，审核 promote 前不参与注入）`,
    });
  }
  if (stats.eventCounts.source === 'insufficient-data') {
    findings.push({
      type: 'no-events', severity: 'low',
      description: `近 ${windowDays} 天无 consumption/outcome/extraction 事件，飞轮尚无运行数据`,
    });
  }
  if (stats.eventCounts.outcomeFailure > stats.eventCounts.outcomeSuccess && stats.eventCounts.outcomeFailure > 0) {
    findings.push({
      type: 'failures-exceed-successes', severity: 'high',
      description: `窗口内失败 outcome (${stats.eventCounts.outcomeFailure}) 多于成功 (${stats.eventCounts.outcomeSuccess})`,
    });
  }
  return findings;
}

/**
 * M1 诚实实现：系统中不存在 analyst 预测 vs 实际结果的结构化数据源。
 * recordAnalystAccuracy() 把数据写成 data/trends/ 的 markdown 文本，且生产代码无任何调用方
 * （仅 @deprecated KnowledgeBus 壳与测试引用）——没有可计算的输入，返回不可用标记而非假空 stub。
 */
export function unavailableAnalystAccuracyReport(): AccuracyReport {
  return {
    available: false,
    reason: '系统中不存在 analyst 预测 vs 实际结果的数据源（recordAnalystAccuracy 生产无调用方，预测/结果未结构化落盘），指标不可用而非编造',
    timestamp: new Date().toISOString(),
  };
}

// ── 事件流扫描（studio-events.jsonl） ──

/**
 * R1 反馈环度量 — 从 studio-events.jsonl 的 `knowledge:outcome:*` 事件实算。
 * （模块级纯函数，不依赖 KnowledgeService 实例，供 getFlywheelMetrics 调用。）
 *
 * 数据源：recordOutcome() 写入的事件
 *   { type: 'knowledge:outcome:success|failure', source, payload, createdAt }
 *   payload 为 JSON string：{ executionId, agentType, success, consumedKnowledge: string[], ... }
 *
 * 指标定义（刻意简单、诚实）：
 * - hitRate（0-100）：滚动窗口内，consumedKnowledge ≥ 1 条的任务（outcome）数 /
 *   窗口内有 outcome 记录的总任务数 × 100。衡量「执行任务时真的注入了知识」的比例。
 * - improvement（百分点，可为负）：窗口按时间中点对半切分，
 *   improvement = (后半窗口成功率 − 前半窗口成功率) × 100。
 *   任一半窗口无事件 → 趋势不可算，记 0（不编造）。
 * - 窗口默认 30 天（opts.windowDays 可覆盖）；opts.eventsFile 供测试注入 fixture。
 * - 窗口内无任何 outcome 事件 → hitRate/improvement = 0 且 source='insufficient-data'。
 */
export async function computeOutcomeMetrics(opts?: { eventsFile?: string; windowDays?: number }): Promise<{ hitRate: number; improvement: number; source: 'events' | 'insufficient-data' }> {
  const windowDays = opts?.windowDays ?? 30;
  const eventsFile = opts?.eventsFile ?? STUDIO_EVENTS_JSONL;
  const now = Date.now();
  const windowStart = now - windowDays * 86400000;

  let rows: any[] = [];
  try {
    // #342：窗口读，sinceMs = windowStart（与下方窗口过滤同口径）——窗口外行不 parse
    rows = await readStudioEventsSince({ file: eventsFile, sinceMs: windowStart });
  } catch {
    rows = []; // 事件文件不存在/不可读 → 数据不足
  }

  const outcomes: Array<{ ts: number; success: boolean; consumed: number }> = [];
  for (const row of rows) {
    if (row?.type !== 'knowledge:outcome:success' && row?.type !== 'knowledge:outcome:failure') continue;
    const tsRaw = row.createdAt ?? row.timestamp;
    const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
    // 容忍 1 分钟时钟偏移；超出窗口或时间戳非法 → 跳过
    if (!Number.isFinite(ts) || ts < windowStart || ts > now + 60_000) continue;
    let payload: any = {};
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {});
    } catch {
      continue; // payload 损坏的行不计入（与 readJsonl 跳过坏行一致，不编造 consumed=0）
    }
    const consumed = Array.isArray(payload.consumedKnowledge) ? payload.consumedKnowledge.length : 0;
    outcomes.push({ ts, success: row.type === 'knowledge:outcome:success', consumed });
  }

  if (outcomes.length === 0) {
    return { hitRate: 0, improvement: 0, source: 'insufficient-data' };
  }

  const hits = outcomes.filter(o => o.consumed > 0).length;
  const hitRate = Math.round((hits / outcomes.length) * 100);

  // improvement: 时间中点切半，后半成功率 − 前半成功率（百分点）
  const midpoint = windowStart + (now - windowStart) / 2;
  const firstHalf = outcomes.filter(o => o.ts < midpoint);
  const secondHalf = outcomes.filter(o => o.ts >= midpoint);
  let improvement = 0;
  if (firstHalf.length > 0 && secondHalf.length > 0) {
    const sr1 = firstHalf.filter(o => o.success).length / firstHalf.length;
    const sr2 = secondHalf.filter(o => o.success).length / secondHalf.length;
    improvement = Math.round((sr2 - sr1) * 100);
  }

  return { hitRate, improvement, source: 'events' };
}

/**
 * M1 审计扫描 — 从 studio-events.jsonl 实算 consumption/outcome/extraction 事件计数与提取活动。
 * （模块级纯函数，不依赖 KnowledgeService 实例，供 getAuditReport 调用；opts.eventsFile 供测试注入。）
 *
 * 计数口径（与 R1 computeOutcomeMetrics 一致的窗口/时钟容差约定）：
 * - 窗口默认 30 天，容忍 1 分钟时钟偏移；窗口外/时间戳非法的行跳过；payload 损坏的行跳过（不计为 0）。
 * - 窗口内四类事件全为 0 → eventCounts.source='insufficient-data'（计数为显式 0，不编造）。
 * - extractionActivity 仅由 knowledge:extraction 事件推导；totalTokens 取 payload.totalTokens 累加，
 *   缺失/非数值按 0 计；lastAt 为最近一次提取事件的 createdAt。
 */
export async function scanKnowledgeEvents(opts?: { eventsFile?: string; windowDays?: number }): Promise<{
  eventCounts: { windowDays: number; consumption: number; outcomeSuccess: number; outcomeFailure: number; extraction: number; source: 'events' | 'insufficient-data' };
  extractionActivity: { count: number; totalTokens: number; lastAt: string | null; source: 'events' | 'insufficient-data' };
  outcomes: Array<{ ts: number; success: boolean }>;
}> {
  const windowDays = opts?.windowDays ?? 30;
  const eventsFile = opts?.eventsFile ?? STUDIO_EVENTS_JSONL;
  const now = Date.now();
  const windowStart = now - windowDays * 86400000;

  let rows: any[] = [];
  try {
    // #342：窗口读，sinceMs = windowStart（与下方窗口过滤同口径）——窗口外行不 parse
    rows = await readStudioEventsSince({ file: eventsFile, sinceMs: windowStart });
  } catch {
    rows = []; // 事件文件不存在/不可读 → 数据不足
  }

  let consumption = 0;
  let outcomeSuccess = 0;
  let outcomeFailure = 0;
  let extraction = 0;
  let extractionTokens = 0;
  let extractionLastAt: string | null = null;
  const outcomes: Array<{ ts: number; success: boolean }> = [];

  for (const row of rows) {
    const type = row?.type;
    if (type !== 'knowledge:consumption'
      && type !== 'knowledge:outcome:success' && type !== 'knowledge:outcome:failure'
      && type !== 'knowledge:extraction') continue;
    const tsRaw = row.createdAt ?? row.timestamp;
    const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
    if (!Number.isFinite(ts) || ts < windowStart || ts > now + 60_000) continue;

    if (type === 'knowledge:consumption') {
      consumption++;
    } else if (type === 'knowledge:extraction') {
      extraction++;
      let payload: any = {};
      try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {});
      } catch {
        continue; // payload 损坏的行不计入
      }
      if (typeof payload.totalTokens === 'number' && Number.isFinite(payload.totalTokens)) {
        extractionTokens += payload.totalTokens;
      }
      const at = row.createdAt ?? row.timestamp;
      if (typeof at === 'string' && (!extractionLastAt || at > extractionLastAt)) extractionLastAt = at;
    } else {
      if (type === 'knowledge:outcome:success') outcomeSuccess++;
      else outcomeFailure++;
      outcomes.push({ ts, success: type === 'knowledge:outcome:success' });
    }
  }

  const anyEvents = consumption + outcomeSuccess + outcomeFailure + extraction > 0;
  return {
    eventCounts: {
      windowDays,
      consumption,
      outcomeSuccess,
      outcomeFailure,
      extraction,
      source: anyEvents ? 'events' : 'insufficient-data',
    },
    extractionActivity: {
      count: extraction,
      totalTokens: extractionTokens,
      lastAt: extractionLastAt,
      source: extraction > 0 ? 'events' : 'insufficient-data',
    },
    outcomes,
  };
}
