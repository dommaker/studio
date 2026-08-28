/**
 * distill-threshold (#143) — 蒸馏门槛检测纯函数（#83 D1 / spec #141）
 *
 * 挂在 WU 收尾钩子上每次 done 跑一次，必须零 LLM 成本：纯确定性计数。
 *
 * 信号口径：
 *   主信号（任一命中）：
 *     - topic：同一 tag 下「新条目」≥ TOPIC_MIN_NEW（3）——重复出现的模式 = 可提炼。
 *       来源限定（#366）：只统计会话沉淀（origin=agent）与人工单发（origin=human）条目；
 *       系统灌入/批量导入（system/external）及未知来源不算「模式自然聚集」，也不入组。
 *       来源标定口径（#371 裁决）：机器流一律 system——monitor 告警、knowledge-sync
 *       遥测/design-doc、pattern-miner 挖掘产物、resolution 落盘均非「模式重复出现」；
 *       钦定矿石 session-summary 显式 origin=agent 计入。recordPattern 缺省 system
 *       （fail-closed），经该门面的写入路径漏标来源不会误触信号（绕过门面直调
 *       store 的写入仍须显式标定）
 *     - manual：manual 人审通过（maturity verified/proven）的「新条目」≥ MANUAL_MIN_NEW（5），
 *       不限来源——过审本身即人背书，与来源解耦
 *   辅条件（必须）：距上次蒸馏运行 ≥ COOLDOWN_DAYS（7）——纯烧钱熔断，限单周最大 LLM 开销
 *
 * 「新条目」= created 严格晚于上次「消费原料」的运行（lastConsumedAt）；从未消费 → 全部算新。
 * 失败/空产出运行只推进熔断时钟（lastRunAt），不推进消费基线——原料不被老化作废。
 * archived / deprecated 条目已退出主区，不参与计数。
 */
export const TOPIC_MIN_NEW = 3;
export const MANUAL_MIN_NEW = 5;
export const COOLDOWN_DAYS = 7;
/** 单次蒸馏原料上限（控制 prompt 规模；超出按 created 升序截断） */
export const MAX_MATERIALS = 20;

const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 3600 * 1000;
/** 已退出主区的 maturity（不计数、不作原料） */
export const EXITED_MATURITY = new Set(['archived', 'deprecated']);
/** manual 人审通过的 maturity 口径（promote 路径：draft→verified→proven）；GC 新生豁免同口径（#144） */
export const MANUAL_APPROVED_MATURITY = new Set(['verified', 'proven']);
/**
 * topic 计数的来源白名单（#366）：只认会话沉淀（agent）与人工单发（human）。
 * system/external 及未知值（存量库存在 'merge' 等类型外历史值）一律不计数——
 * 批量打标/灌入误触蒸馏的修复闸门；漏触发有 manual 信号与提案卡人审兜底，故 fail-closed。
 */
export const TOPIC_ELIGIBLE_ORIGINS = new Set(['agent', 'human']);

export interface DistillThresholdEntry {
  id: string;
  tags: string[];
  /** ISO 8601 创建时间 */
  created: string;
  maturity: string;
  /** 条目来源（KnowledgeEntry.origin；#366 起参与 topic 计数需在 TOPIC_ELIGIBLE_ORIGINS 内） */
  origin?: string;
}

export interface DistillTopicGroup {
  tag: string;
  entryIds: string[];
}

export interface DistillSignals {
  /** 命中的 topic 组（组内 ≥ TOPIC_MIN_NEW），按组大小降序、tag 字典序稳定 */
  topicGroups: DistillTopicGroup[];
  /** manual 过审新条目（全量列出；构成信号需 ≥ MANUAL_MIN_NEW） */
  manualEntryIds: string[];
}

export interface DistillThresholdResult {
  fire: boolean;
  /** 未点火原因（fire=false 时）：no-signal=主信号未命中；cooldown=7 天熔断内 */
  reason?: 'no-signal' | 'cooldown';
  signals: DistillSignals;
  /** 命中信号构成的原料 id（确定性排序；fire=false 时为空） */
  materialIds: string[];
}

/**
 * 门槛基线（两个时间戳职责分离）：
 *   - lastRunAt：上次运行时间（任何 outcome，含失败/空产出——烧了 token 就算），烧钱熔断输入
 *   - lastConsumedAt：上次实际消费原料的运行时间（executed 且产物 ≥1），「新条目」基线——
 *     失败/空产出不消费原料，原料不能因此被老化作废（下次门槛仍要能看到它们）
 */
export interface DistillThresholdBaseline {
  lastRunAt: string | null;
  lastConsumedAt: string | null;
}

function parseTime(iso: string): number {
  return new Date(iso).getTime(); // 非法输入 → NaN（调用方判 Number.isFinite）
}

/** 确定性排序：created 升序，id 字典序收尾（同输入不同顺序 → 同输出） */
function byCreatedThenId(a: DistillThresholdEntry, b: DistillThresholdEntry): number {
  const ta = parseTime(a.created);
  const tb = parseTime(b.created);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function evaluateDistillThreshold(
  entries: DistillThresholdEntry[],
  baseline: DistillThresholdBaseline,
  now: Date = new Date(),
): DistillThresholdResult {
  const lastRunMs = baseline.lastRunAt ? parseTime(baseline.lastRunAt) : NaN;
  const lastConsumedMs = baseline.lastConsumedAt ? parseTime(baseline.lastConsumedAt) : NaN;

  // 新条目 = 主区内 + created 严格晚于上次「消费」（从未消费/时间戳非法 → 全部算新）
  const fresh = entries
    .filter(e => !EXITED_MATURITY.has(e.maturity))
    .filter(e => Number.isFinite(parseTime(e.created)))
    .filter(e => !Number.isFinite(lastConsumedMs) || parseTime(e.created) > lastConsumedMs)
    .sort(byCreatedThenId);

  // topic 信号：来源白名单过滤（#366）后按 tag 分组，每组 ≥ TOPIC_MIN_NEW 命中。
  // 条目级过滤：不可计条目不凑数、不进组（避免批量灌入条目混入原料清单）
  const byTag = new Map<string, DistillThresholdEntry[]>();
  for (const e of fresh) {
    if (!e.origin || !TOPIC_ELIGIBLE_ORIGINS.has(e.origin)) continue;
    for (const tag of e.tags) {
      const group = byTag.get(tag);
      if (group) group.push(e);
      else byTag.set(tag, [e]);
    }
  }
  const topicGroups: DistillTopicGroup[] = [...byTag.entries()]
    .filter(([, members]) => members.length >= TOPIC_MIN_NEW)
    .map(([tag, members]) => ({ tag, entryIds: members.map(m => m.id) }))
    .sort((a, b) => b.entryIds.length - a.entryIds.length || (a.tag < b.tag ? -1 : 1));

  // manual 信号：verified/proven 新条目
  const manualEntryIds = fresh.filter(e => MANUAL_APPROVED_MATURITY.has(e.maturity)).map(e => e.id);

  const hasSignal = topicGroups.length > 0 || manualEntryIds.length >= MANUAL_MIN_NEW;
  if (!hasSignal) {
    return { fire: false, reason: 'no-signal', signals: { topicGroups, manualEntryIds }, materialIds: [] };
  }

  // 烧钱熔断：距上次运行 < 7 天不点火（从未运行 → 通过）
  if (Number.isFinite(lastRunMs) && now.getTime() - lastRunMs < COOLDOWN_MS) {
    return { fire: false, reason: 'cooldown', signals: { topicGroups, manualEntryIds }, materialIds: [] };
  }

  const materialIds = [...new Set([...topicGroups.flatMap(g => g.entryIds), ...manualEntryIds])]
    .slice(0, MAX_MATERIALS);
  return { fire: true, signals: { topicGroups, manualEntryIds }, materialIds };
}
