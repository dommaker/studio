/**
 * gc-candidates (#144) — GC 候选清单周期计龄纯函数测试（表驱动）
 *
 * 覆盖（对应 #144 AC）：
 *   - 恰好 3 周期边界：lastReferenced 早于第 3 次蒸馏运行 → 候选；等于/晚于 → 不候选
 *   - manual 过审（verified/proven）3 周期新生豁免：豁免期内不进候选，豁免过后同规则
 *   - signal 层跳过（归蒸馏生命周期）、rule 层跳过（归 #139）：只覆盖 reference/context 层
 *   - 主区 >200 条无条件强制出清单（放宽「≥3 个周期」门，有多少周期用多少）
 *   - 判据不读墙钟：构造「闲置三个月」数据（运行序列与条目都停在三个月前）验证无误杀
 *   - archived/deprecated 已退出主区不参与；lastReferenced 非法跳过（不冤杀）
 */
import { describe, it, expect } from 'vitest';
import {
  generateGcCandidates,
  GC_REQUIRED_CYCLES,
  GC_MAIN_AREA_LIMIT,
  type GcAgingEntry,
} from '../gc-candidates.js';

// 三个蒸馏周期（升序）
const R1 = '2026-07-01T00:00:00.000Z';
const R2 = '2026-07-15T00:00:00.000Z';
const R3 = '2026-08-01T00:00:00.000Z';
const RUNS = [R1, R2, R3];
// 恰好 3 周期边界：cutoff = 第 3 次运行（正数第 1 个）
const CUTOFF = R1;

let seq = 0;
function entry(over: Partial<GcAgingEntry> = {}): GcAgingEntry {
  seq += 1;
  return {
    id: over.id ?? `e-${seq}`,
    title: over.title ?? `entry ${seq}`,
    consumptionMode: 'reference',
    maturity: 'active',
    created: '2026-06-01T00:00:00.000Z',
    lastReferenced: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('恰好 3 周期边界（cutoff = 倒数第 3 次运行）', () => {
  const cases: Array<{ name: string; lastReferenced: string; candidate: boolean }> = [
    { name: 'lastReferenced 早于 cutoff 1 秒 → 连续 3 周期零引用 → 候选', lastReferenced: '2026-06-30T23:59:59.000Z', candidate: true },
    { name: 'lastReferenced 恰等于 cutoff → 不算零引用（边界外）', lastReferenced: CUTOFF, candidate: false },
    { name: 'lastReferenced 晚于 cutoff（零引用仅 2 周期）→ 不候选', lastReferenced: '2026-07-02T00:00:00.000Z', candidate: false },
    { name: 'lastReferenced 晚于最近一次运行 → 不候选', lastReferenced: '2026-08-02T00:00:00.000Z', candidate: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const result = generateGcCandidates([entry({ lastReferenced: c.lastReferenced })], RUNS);
      expect(result.candidates.map(x => x.entryId)).toEqual(c.candidate ? ['e-1'] : []);
      expect(result.cutoff).toBe(CUTOFF);
      expect(result.forced).toBe(false);
    });
  }

  it('周期不足 3 个 → 不出候选（非强制）', () => {
    const result = generateGcCandidates(
      [entry({ lastReferenced: '2026-06-01T00:00:00.000Z' })],
      [R2, R3],
    );
    expect(result.candidates).toEqual([]);
  });

  it('候选附可读理由：连续周期数 + 零引用周期时间戳', () => {
    const result = generateGcCandidates(
      [entry({ lastReferenced: '2026-06-01T00:00:00.000Z' })],
      RUNS,
    );
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.zeroRefStreak).toBe(3);
    expect(c.zeroRefCycles).toEqual([R1, R2, R3]);
    expect(c.reason).toContain('3');
    expect(c.reason).toContain('2026-07-01');
    expect(c.reason).toContain('2026-08-01');
    expect(c.reason).toContain('2026-06-01'); // lastReferenced 停留点
  });

  it('零引用周期超过 3 个时理由给出完整 streak，周期列最近 3 个', () => {
    const fiveRuns = ['2026-06-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z', R1, R2, R3];
    const result = generateGcCandidates(
      [entry({ lastReferenced: '2026-05-01T00:00:00.000Z' })],
      fiveRuns,
    );
    const c = result.candidates[0];
    expect(c.zeroRefStreak).toBe(5);
    expect(c.zeroRefCycles).toEqual([R1, R2, R3]);
    expect(c.reason).toContain('5');
  });
});

describe('manual 过审条目 3 周期新生豁免', () => {
  it('豁免期内（created 晚于 cutoff）即使 lastReferenced 过线也不候选', () => {
    const result = generateGcCandidates(
      [entry({ maturity: 'verified', created: '2026-07-10T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' })],
      RUNS,
    );
    expect(result.candidates).toEqual([]);
  });

  it('豁免过后同规则：created 早于 cutoff 且 lastReferenced 过线 → 候选', () => {
    const result = generateGcCandidates(
      [entry({ id: 'manual-old', maturity: 'proven', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' })],
      RUNS,
    );
    expect(result.candidates.map(c => c.entryId)).toEqual(['manual-old']);
  });

  it('非 manual 条目（active/draft）不享豁免', () => {
    const result = generateGcCandidates(
      [entry({ id: 'draft-new', maturity: 'draft', created: '2026-07-10T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' })],
      RUNS,
    );
    expect(result.candidates.map(c => c.entryId)).toEqual(['draft-new']);
  });
});

describe('分层规则：signal/rule 跳过，只覆盖 reference/context + 蒸馏产物', () => {
  it('signal / rule 层条目永不进候选', () => {
    const result = generateGcCandidates(
      [
        entry({ id: 'sig', consumptionMode: 'signal', lastReferenced: '2026-01-01T00:00:00.000Z' }),
        entry({ id: 'rule', consumptionMode: 'rule', lastReferenced: '2026-01-01T00:00:00.000Z' }),
        entry({ id: 'ref', consumptionMode: 'reference', lastReferenced: '2026-01-01T00:00:00.000Z' }),
        entry({ id: 'ctx', consumptionMode: 'context', lastReferenced: '2026-01-01T00:00:00.000Z' }),
      ],
      RUNS,
    );
    expect(result.candidates.map(c => c.entryId).sort()).toEqual(['ctx', 'ref']);
  });

  it('archived/deprecated 已退出主区 → 不参与候选也不计主区容量', () => {
    const result = generateGcCandidates(
      [
        entry({ id: 'a', maturity: 'archived', lastReferenced: '2026-01-01T00:00:00.000Z' }),
        entry({ id: 'd', maturity: 'deprecated', lastReferenced: '2026-01-01T00:00:00.000Z' }),
      ],
      RUNS,
    );
    expect(result.candidates).toEqual([]);
    expect(result.mainAreaCount).toBe(0);
  });

  it('lastReferenced 非法 → 跳过不冤杀', () => {
    const result = generateGcCandidates(
      [entry({ lastReferenced: 'not-a-date' })],
      RUNS,
    );
    expect(result.candidates).toEqual([]);
  });
});

describe('主区 >200 条强制出清单', () => {
  function mainAreaEntries(n: number, lastReferenced: string): GcAgingEntry[] {
    return Array.from({ length: n }, (_, i) => entry({ id: `bulk-${i}`, lastReferenced }));
  }

  it(`主区 ${GC_MAIN_AREA_LIMIT + 1} 条 + 仅 1 个周期 → 强制出清单（放宽周期门）`, () => {
    const entries = mainAreaEntries(GC_MAIN_AREA_LIMIT + 1, '2026-06-01T00:00:00.000Z');
    const result = generateGcCandidates(entries, [R3]);
    expect(result.forced).toBe(true);
    expect(result.mainAreaCount).toBe(GC_MAIN_AREA_LIMIT + 1);
    // cutoff 退化为仅有的 1 个周期：lastReferenced 早于它 → 全部进候选
    expect(result.candidates).toHaveLength(GC_MAIN_AREA_LIMIT + 1);
    expect(result.cutoff).toBe(R3);
  });

  it(`主区恰好 ${GC_MAIN_AREA_LIMIT} 条 + 仅 1 个周期 → 非强制，不出清单`, () => {
    const entries = mainAreaEntries(GC_MAIN_AREA_LIMIT, '2026-06-01T00:00:00.000Z');
    const result = generateGcCandidates(entries, [R3]);
    expect(result.forced).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('强制但零运行记录 → 无周期可计龄，清单为空', () => {
    const entries = mainAreaEntries(GC_MAIN_AREA_LIMIT + 1, '2026-06-01T00:00:00.000Z');
    const result = generateGcCandidates(entries, []);
    expect(result.forced).toBe(true);
    expect(result.candidates).toEqual([]);
  });
});

describe('判据不读墙钟：闲置三个月无误杀', () => {
  // 系统闲置三个月：蒸馏运行序列停在三个月前，条目也都是老数据
  const OLD_RUNS = ['2026-05-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z', '2026-05-15T00:00:00.000Z'];

  it('条目在最后 3 个周期内被引用过 → 不候选（哪怕按墙钟已三个月）', () => {
    const result = generateGcCandidates(
      [entry({ lastReferenced: '2026-05-10T00:00:00.000Z', created: '2026-01-01T00:00:00.000Z' })],
      OLD_RUNS,
    );
    expect(result.candidates).toEqual([]);
  });

  it('闲置期间新建的条目（created/lastReferenced 晚于最后运行）→ 不候选', () => {
    const result = generateGcCandidates(
      [entry({ created: '2026-08-10T00:00:00.000Z', lastReferenced: '2026-08-10T00:00:00.000Z' })],
      OLD_RUNS,
    );
    expect(result.candidates).toEqual([]);
  });

  it('确实连续 3 周期零引用的老条目仍候选（判据只看周期不看墙钟）', () => {
    const result = generateGcCandidates(
      [entry({ id: 'stale', lastReferenced: '2026-04-01T00:00:00.000Z', created: '2026-01-01T00:00:00.000Z' })],
      OLD_RUNS,
    );
    expect(result.candidates.map(c => c.entryId)).toEqual(['stale']);
  });
});

describe('确定性输出', () => {
  it('候选按 lastReferenced 升序、id 字典序收尾，与输入顺序无关', () => {
    const entries = [
      entry({ id: 'b', lastReferenced: '2026-06-01T00:00:00.000Z' }),
      entry({ id: 'a', lastReferenced: '2026-06-01T00:00:00.000Z' }),
      entry({ id: 'c', lastReferenced: '2026-05-01T00:00:00.000Z' }),
    ];
    const result = generateGcCandidates(entries, RUNS);
    expect(result.candidates.map(c => c.entryId)).toEqual(['c', 'a', 'b']);
  });

  it('运行时间戳无需调用方排序（内部排序，非法时间戳忽略）', () => {
    const result = generateGcCandidates(
      [entry({ id: 'x', lastReferenced: '2026-06-01T00:00:00.000Z' })],
      [R3, 'garbage', R1, R2],
    );
    expect(result.candidates.map(c => c.entryId)).toEqual(['x']);
    expect(result.cycleCount).toBe(3);
  });

  it(`常量：周期阈值 ${GC_REQUIRED_CYCLES}=3，主区上限 ${GC_MAIN_AREA_LIMIT}=200`, () => {
    expect(GC_REQUIRED_CYCLES).toBe(3);
    expect(GC_MAIN_AREA_LIMIT).toBe(200);
  });
});
