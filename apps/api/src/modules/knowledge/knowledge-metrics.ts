/**
 * knowledge-metrics — 飞轮/审计的事件流度量（R1/M1）
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：从 studio-events.jsonl
 * 实算 outcome 命中率/改善度（computeOutcomeMetrics）与
 * consumption/outcome/extraction 事件计数（scanKnowledgeEvents）。
 * 模块级纯函数（不依赖 KnowledgeService 实例），
 * 供 getFlywheelMetrics / getAuditReport 调用。
 */

import { fileStore, STUDIO_EVENTS_JSONL } from './knowledge-data-layer.js';

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
async function computeOutcomeMetrics(opts?: { eventsFile?: string; windowDays?: number }): Promise<{ hitRate: number; improvement: number; source: 'events' | 'insufficient-data' }> {
  const windowDays = opts?.windowDays ?? 30;
  const eventsFile = opts?.eventsFile ?? STUDIO_EVENTS_JSONL;
  const now = Date.now();
  const windowStart = now - windowDays * 86400000;

  let rows: any[] = [];
  try {
    rows = await fileStore.readJsonl<any>(eventsFile);
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
async function scanKnowledgeEvents(opts?: { eventsFile?: string; windowDays?: number }): Promise<{
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
    rows = await fileStore.readJsonl<any>(eventsFile);
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

export { computeOutcomeMetrics, scanKnowledgeEvents };
