/**
 * gc-candidates (#144) — GC 候选清单周期计龄纯函数（#83 D4 / spec #141）
 *
 * 判据（分层、不打分、不读墙钟）：
 *   - 只覆盖 reference/context 层（含蒸馏产物，consumptionMode=reference）；
 *     signal 层跳过（归蒸馏生命周期），rule 层跳过（归 #139 判据）
 *   - reference/context 条目：连续 GC_REQUIRED_CYCLES（3）个蒸馏周期 lastReferenced
 *     未更新 → 候选。计龄单位是「蒸馏运行」（runTimestamps 序列），不是墙钟——
 *     系统闲置三个月 → 无新蒸馏运行 → 无新周期 → 无人过线冤案，GC 自然休眠
 *   - manual 过审条目（verified/proven）享 3 周期新生豁免：created 落在最近 3 个
 *     周期内不进候选，豁免过后同规则
 *   - 主区条目 > GC_MAIN_AREA_LIMIT（200）→ 无条件强制出清单：放宽「≥3 个周期」
 *     门，有多少周期用多少（cutoff 退化为最早的可用周期）；零运行记录则无期可计
 *
 * 输出候选附可读理由（哪几个周期零引用、lastReferenced 停留在哪），供人审卡终审。
 * archived/deprecated 已退出主区：不参与候选，也不计主区容量。
 */
import { EXITED_MATURITY, MANUAL_APPROVED_MATURITY } from './distill-threshold.js';

/** 连续零引用周期阈值（D4：连续 3 个蒸馏周期） */
export const GC_REQUIRED_CYCLES = 3;
/** 主区容量硬上限（#78 决议；超过无条件强制出清单） */
export const GC_MAIN_AREA_LIMIT = 200;
/** GC 只覆盖的消费层（signal 归蒸馏生命周期、rule 归 #139） */
const GC_ELIGIBLE_MODES = new Set(['reference', 'context']);
/** 理由里最多列出的零引用周期数（最近的优先） */
const REASON_MAX_CYCLES = 3;

export interface GcAgingEntry {
  id: string;
  title: string;
  consumptionMode: string;
  maturity: string;
  /** ISO 8601 创建时间（manual 新生豁免的计龄起点） */
  created: string;
  /** ISO 8601 最后引用时间（零引用判据） */
  lastReferenced: string;
}

export interface GcCandidate {
  entryId: string;
  title: string;
  /** 连续零引用周期数（≥ GC_REQUIRED_CYCLES，强制模式可更少） */
  zeroRefStreak: number;
  /** 零引用周期（蒸馏运行时间戳升序；超过 REASON_MAX_CYCLES 只列最近几个） */
  zeroRefCycles: string[];
  /** 可读理由（人审卡展示） */
  reason: string;
}

export interface GcCandidateResult {
  candidates: GcCandidate[];
  /** 主区条目数（排除 archived/deprecated；>200 强制的输入） */
  mainAreaCount: number;
  /** 是否因主区超容量强制出清单 */
  forced: boolean;
  /** 参与计龄的蒸馏周期数（合法运行时间戳个数） */
  cycleCount: number;
  /** 本次计龄 cutoff（lastReferenced 早于它才计零引用；无可用周期 → null） */
  cutoff: string | null;
}

function parseTime(iso: string): number {
  return new Date(iso).getTime(); // 非法输入 → NaN
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 生成 GC 候选清单。runTimestamps = 蒸馏运行时间戳序列（乱序可，内部排序；
 * 非法时间戳忽略）。不读墙钟——判据只比较条目时间戳与运行序列。
 */
export function generateGcCandidates(
  entries: GcAgingEntry[],
  runTimestamps: string[],
): GcCandidateResult {
  const runs = runTimestamps
    .filter(ts => Number.isFinite(parseTime(ts)))
    .sort((a, b) => parseTime(a) - parseTime(b));

  const mainArea = entries.filter(e => !EXITED_MATURITY.has(e.maturity));
  const forced = mainArea.length > GC_MAIN_AREA_LIMIT;

  // 周期门：正常需 ≥3 个周期；主区超容量强制时有多少用多少（≥1）
  const enoughCycles = runs.length >= GC_REQUIRED_CYCLES;
  if (!enoughCycles && !forced) {
    return { candidates: [], mainAreaCount: mainArea.length, forced, cycleCount: runs.length, cutoff: null };
  }
  if (runs.length === 0) {
    return { candidates: [], mainAreaCount: mainArea.length, forced, cycleCount: 0, cutoff: null };
  }

  // cutoff = 倒数第 3 个周期（不足 3 个时退化为最早周期——强制模式）
  const cutoffIdx = Math.max(0, runs.length - GC_REQUIRED_CYCLES);
  const cutoff = runs[cutoffIdx];
  const cutoffMs = parseTime(cutoff);

  // 确定性输出：先按 lastReferenced 升序、id 字典序收尾排好，候选沿用该顺序
  const eligible = mainArea
    .filter(e => GC_ELIGIBLE_MODES.has(e.consumptionMode)) // signal/rule 各有归属
    .filter(e => Number.isFinite(parseTime(e.lastReferenced))) // 数据非法不冤杀
    .sort((a, b) =>
      parseTime(a.lastReferenced) - parseTime(b.lastReferenced) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const candidates: GcCandidate[] = [];
  for (const e of eligible) {
    const lastRefMs = parseTime(e.lastReferenced);
    if (lastRefMs >= cutoffMs) continue; // 最近周期内有引用
    // manual 过审新生豁免：created 落在 cutoff 之后（豁免窗口内）不进候选
    if (MANUAL_APPROVED_MATURITY.has(e.maturity) && parseTime(e.created) >= cutoffMs) continue;

    const zeroRef = runs.filter(r => parseTime(r) > lastRefMs);
    const listed = zeroRef.slice(-REASON_MAX_CYCLES);
    const reason =
      `连续 ${zeroRef.length} 个蒸馏周期零引用` +
      `（lastReferenced 停留在 ${dayOf(e.lastReferenced)}；` +
      `零引用周期：${listed.map(dayOf).join('、')}）`;
    candidates.push({
      entryId: e.id,
      title: e.title,
      zeroRefStreak: zeroRef.length,
      zeroRefCycles: listed,
      reason,
    });
  }

  return { candidates, mainAreaCount: mainArea.length, forced, cycleCount: runs.length, cutoff };
}
