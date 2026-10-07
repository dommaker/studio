/**
 * knowledge-measure — Measure 能力实现（flywheel metrics / health / audit / accuracy）
 *
 * 自 knowledge-service.ts 整块抽出（#669 刀2，纯代码移动不改行为）：
 * KnowledgeService.getFlywheelMetrics / getHealthReport / getAuditReport /
 * getAnalystAccuracy / getStats 的实现体（实算内核本就在 knowledge-metrics.ts，
 * 本模块是 store/事件流数据装配层）。
 * 模块级函数（不占 KnowledgeService prototype 方法数，knowledge-service.test.ts 锁定 33），
 * 门面方法为薄封装。
 */

import {
  computeOutcomeMetrics,
  scanKnowledgeEvents,
  computeFlywheelStoreMetrics,
  computeHealthReport,
  emptyHealthReport,
  computeAuditStorePartition,
  deriveOutcomeTrend,
  buildAuditFindings,
  unavailableAnalystAccuracyReport,
} from './knowledge-metrics.js';
import type { FlywheelMetrics, HealthReport, AuditReport, AccuracyReport } from './knowledge-metrics.js';
import type { KnowledgeServiceDeps } from './knowledge-types.js';

export async function getFlywheelMetricsImpl(deps: KnowledgeServiceDeps, opts?: { eventsFile?: string; windowDays?: number }): Promise<FlywheelMetrics> {
  const timestamp = new Date().toISOString();
  try {
    const entries = deps.store.list({});
    // store 分区（quality/freshness）实算内核在 knowledge-metrics 模块级纯函数
    const { quality, freshness } = computeFlywheelStoreMetrics(entries);

    // R1: hitRate / improvement 从 outcome 事件实算（断点 A 修复，此前硬编码 0）
    // 模块级纯函数（不依赖 this），保持 KnowledgeService 公共方法面不变
    const outcomeMetrics = await computeOutcomeMetrics(opts);

    return { quality, hitRate: outcomeMetrics.hitRate, improvement: outcomeMetrics.improvement, freshness, timestamp, source: outcomeMetrics.source };
  } catch {
    return { quality: 0, hitRate: 0, improvement: 0, freshness: 0, timestamp, source: 'insufficient-data' };
  }
}

export async function getHealthReportImpl(deps: KnowledgeServiceDeps): Promise<HealthReport> {
  try {
    const entries = deps.store.list({});
    return computeHealthReport(entries);
  } catch {
    return emptyHealthReport();
  }
}

/**
 * M1: 实算审计报告（断点 I 修复，此前返回空 stub）。
 * 数据源：studio-events.jsonl 事件流（consumption/outcome/extraction）+ KnowledgeStore。
 * 事件流无数据的分区返回显式 0 + source='insufficient-data'（与 getFlywheelMetrics 同一诚实约定）。
 */
export async function getAuditReportImpl(deps: KnowledgeServiceDeps, opts?: { eventsFile?: string; windowDays?: number }): Promise<AuditReport> {
  const windowDays = opts?.windowDays ?? 30;
  const timestamp = new Date().toISOString();

  // ── store 分区（恒有数据源） ──
  let entries: AuditReport['entries'] = { total: 0, byMaturity: {}, source: 'store' };
  let topReferenced: AuditReport['topReferenced'] = [];
  try {
    const all = deps.store.list({});
    ({ entries, topReferenced } = computeAuditStorePartition(all));
  } catch { /* store 读取失败 → 显式 0 */ }

  // ── 事件流分区 ──
  const stats = await scanKnowledgeEvents(opts);

  // trend / findings 均由 knowledge-metrics 模块级纯函数从实算数据派生，不预造
  const trend = deriveOutcomeTrend(stats.outcomes, windowDays);
  const findings = buildAuditFindings({ entries, stats, windowDays });

  return {
    findings,
    trend,
    timestamp,
    eventCounts: stats.eventCounts,
    entries,
    topReferenced,
    extractionActivity: stats.extractionActivity,
  };
}

/**
 * M1 诚实实现：系统中不存在 analyst 预测 vs 实际结果的结构化数据源。
 * recordAnalystAccuracy() 把数据写成 data/trends/ 的 markdown 文本，且生产代码无任何调用方
 * （仅 @deprecated KnowledgeBus 壳与测试引用）——没有可计算的输入，返回不可用标记而非假空 stub。
 */
export async function getAnalystAccuracyImpl(_deps: KnowledgeServiceDeps): Promise<AccuracyReport> {
  return unavailableAnalystAccuracyReport();
}

/**
 * 知识统计概览 — absorbed from KnowledgeBus.getStats()
 */
export function getStatsImpl(deps: KnowledgeServiceDeps): Record<string, number> {
  try {
    const entries = deps.store.list({});
    const byType: Record<string, number> = {};
    for (const e of entries) {
      const cat = (e as any).tags?.[0] || 'other';
      byType[cat] = (byType[cat] || 0) + 1;
    }
    byType.total = entries.length;
    return byType;
  } catch {
    return { total: 0 };
  }
}
