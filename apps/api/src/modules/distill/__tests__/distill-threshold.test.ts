/**
 * distill-threshold (#143) — 门槛检测纯函数表驱动测试
 *
 * 口径（#83 D1 / spec #141）：
 *   主信号（任一）：同 topic/tag 新条目 ≥3；或 manual 过审（verified/proven）新条目 ≥5
 *   辅条件（必须）：距上次蒸馏运行 ≥7 天（烧钱熔断；从未运行过 → 通过）
 *   「新条目」= created 晚于上次蒸馏运行时间；archived/deprecated 不计（已退出主区）
 * 纯确定性计数，零 LLM 成本。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateDistillThreshold,
  TOPIC_MIN_NEW,
  MANUAL_MIN_NEW,
  COOLDOWN_DAYS,
  MAX_MATERIALS,
  type DistillThresholdEntry,
} from '../distill-threshold.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
}

let seq = 0;
function entry(over: Partial<DistillThresholdEntry> = {}): DistillThresholdEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    tags: ['session-summary'],
    created: daysAgo(1),
    maturity: 'active',
    origin: 'agent', // FileKnowledgeStore 落库同语义：缺失视为 agent 沉淀
    ...over,
  };
}

function oreGroup(tag: string, n: number, over: Partial<DistillThresholdEntry> = {}): DistillThresholdEntry[] {
  return Array.from({ length: n }, () => entry({ tags: [tag], ...over }));
}

interface Case {
  name: string;
  entries: DistillThresholdEntry[];
  /** 上次运行（任何 outcome）——熔断时钟 */
  lastRunAt: string | null;
  /** 上次实际消费原料的运行——「新条目」基线；缺省 = lastRunAt（成功运行同时推进两者） */
  lastConsumedAt?: string | null;
  expectFire: boolean;
  expectReason?: 'no-signal' | 'cooldown';
  expectMaterialIds?: string[];
  expectTopicTags?: string[];
  expectManualCount?: number;
}

const cases: Case[] = [
  {
    name: '空库 → 不点火',
    entries: [],
    lastRunAt: null,
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: `同 tag ${TOPIC_MIN_NEW - 1} 条新条目 → 未达阈值`,
    entries: oreGroup('t-a', TOPIC_MIN_NEW - 1),
    lastRunAt: null,
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: `同 tag ${TOPIC_MIN_NEW} 条新条目 → 点火（topic 信号边界）`,
    entries: oreGroup('t-a', TOPIC_MIN_NEW),
    lastRunAt: null,
    expectFire: true,
    expectTopicTags: ['t-a'],
  },
  {
    name: `${MANUAL_MIN_NEW - 1} 条 manual 过审新条目 → 未达阈值`,
    entries: Array.from({ length: MANUAL_MIN_NEW - 1 }, (_, i) => entry({ maturity: 'verified', tags: [`manual-${i}`] })),
    lastRunAt: null,
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: `${MANUAL_MIN_NEW} 条 manual 过审新条目 → 点火（manual 信号边界）`,
    entries: Array.from({ length: MANUAL_MIN_NEW }, (_, i) => entry({ maturity: 'verified', tags: [`manual-${i}`] })),
    lastRunAt: null,
    expectFire: true,
    expectManualCount: MANUAL_MIN_NEW,
  },
  {
    name: 'proven 同样算 manual 过审',
    entries: Array.from({ length: MANUAL_MIN_NEW }, (_, i) => entry({ maturity: 'proven', tags: [`manual-${i}`] })),
    lastRunAt: null,
    expectFire: true,
    expectManualCount: MANUAL_MIN_NEW,
  },
  {
    name: 'topic 信号命中但距上次运行 <7 天 → 熔断不点火',
    entries: oreGroup('t-a', TOPIC_MIN_NEW),
    lastRunAt: daysAgo(COOLDOWN_DAYS - 1),
    expectFire: false,
    expectReason: 'cooldown',
  },
  {
    name: '距上次运行恰好 7 天 → 熔断边界通过，点火',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { created: daysAgo(6) }),
    lastRunAt: daysAgo(COOLDOWN_DAYS),
    expectFire: true,
  },
  {
    name: '信号与熔断同时不满足时优先报 no-signal',
    entries: oreGroup('t-a', TOPIC_MIN_NEW - 1),
    lastRunAt: daysAgo(2),
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: 'archived / deprecated 条目不参与计数（已退出主区）',
    entries: [
      ...oreGroup('t-a', TOPIC_MIN_NEW, { maturity: 'archived' }),
      ...oreGroup('t-b', TOPIC_MIN_NEW, { maturity: 'deprecated' }),
    ],
    lastRunAt: null,
    expectFire: false,
    expectReason: 'no-signal',
  },
  // ── #366 来源限定：topic 只认会话沉淀（agent）/人工单发（human），系统灌入不算模式聚集 ──
  {
    name: '同 tag 全 system 来源（冷启动灌入形态）→ topic 不点火',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { origin: 'system' }),
    lastRunAt: null,
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: '同 tag 全 external 来源（批量导入形态）→ topic 不点火',
    entries: oreGroup('t-a', TOPIC_MIN_NEW + 2, { origin: 'external' }),
    lastRunAt: null,
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: '同 tag 全 human 来源 → 照常点火（人工单发是自然产出）',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { origin: 'human' }),
    lastRunAt: null,
    expectFire: true,
    expectTopicTags: ['t-a'],
  },
  {
    name: '上次运行之前的旧条目不认定为「新」',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { created: daysAgo(10) }),
    lastRunAt: daysAgo(8),
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: 'created 恰好等于上次消费时间 → 不算新（严格大于）',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { created: daysAgo(8) }),
    lastRunAt: daysAgo(8),
    expectFire: false,
    expectReason: 'no-signal',
  },
  {
    name: '失败运行不老化原料：熔断期内信号仍可见（不点火但 topic 组在）',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { created: daysAgo(5) }),
    lastRunAt: daysAgo(3), // 失败运行只推进熔断时钟
    lastConsumedAt: null, // 消费基线从未推进 → 5 天前的原料仍是「新」
    expectFire: false,
    expectReason: 'cooldown',
    expectTopicTags: ['t-a'],
  },
  {
    name: '失败运行不老化原料：熔断期外旧原料照样点火',
    entries: oreGroup('t-a', TOPIC_MIN_NEW, { created: daysAgo(5) }),
    lastRunAt: daysAgo(8),
    lastConsumedAt: null,
    expectFire: true,
    expectTopicTags: ['t-a'],
  },
];

describe('evaluateDistillThreshold — 表驱动', () => {
  for (const c of cases) {
    it(c.name, () => {
      const baseline = { lastRunAt: c.lastRunAt, lastConsumedAt: c.lastConsumedAt !== undefined ? c.lastConsumedAt : c.lastRunAt };
      const r = evaluateDistillThreshold(c.entries, baseline, NOW);
      expect(r.fire).toBe(c.expectFire);
      if (c.expectReason) expect(r.reason).toBe(c.expectReason);
      if (c.expectFire) {
        expect(r.materialIds.length).toBeGreaterThan(0);
      } else {
        expect(r.materialIds).toEqual([]);
      }
      if (c.expectTopicTags) expect(r.signals.topicGroups.map(g => g.tag)).toEqual(c.expectTopicTags);
      if (c.expectManualCount !== undefined) expect(r.signals.manualEntryIds).toHaveLength(c.expectManualCount);
    });
  }
});

describe('evaluateDistillThreshold — 原料清单语义', () => {
  it('原料 = 命中 topic 组 ∪ manual 条目（去重）', () => {
    const shared = entry({ tags: ['t-a'], maturity: 'verified' });
    const entries = [...oreGroup('t-a', TOPIC_MIN_NEW - 1), shared];
    const r = evaluateDistillThreshold(entries, { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r.fire).toBe(true);
    // 3 条 topic 组成员 + shared 同时是 verified，但只计一次
    expect(new Set(r.materialIds).size).toBe(r.materialIds.length);
    expect(r.materialIds).toContain(shared.id);
    expect(r.materialIds).toHaveLength(TOPIC_MIN_NEW);
  });

  it('未命中信号的条目不进原料清单（其它 tag 散件）', () => {
    const noise = entry({ tags: ['t-noise-1'] });
    const entries = [...oreGroup('t-a', TOPIC_MIN_NEW), noise];
    const r = evaluateDistillThreshold(entries, { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r.fire).toBe(true);
    expect(r.materialIds).not.toContain(noise.id);
  });

  it(`原料清单截断到 ${MAX_MATERIALS} 条且确定性排序（created 升序，id 次序稳定）`, () => {
    const entries = oreGroup('t-a', MAX_MATERIALS + 10);
    const r1 = evaluateDistillThreshold(entries, { lastRunAt: null, lastConsumedAt: null }, NOW);
    const r2 = evaluateDistillThreshold([...entries].reverse(), { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r1.materialIds).toHaveLength(MAX_MATERIALS);
    expect(r1.materialIds).toEqual(r2.materialIds);
  });

  it('同一条目挂多个命中 tag 只计一次', () => {
    const e1 = entry({ tags: ['t-a', 't-b'] });
    const e2 = entry({ tags: ['t-a', 't-b'] });
    const e3 = entry({ tags: ['t-a', 't-b'] });
    const r = evaluateDistillThreshold([e1, e2, e3], { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r.fire).toBe(true);
    expect(r.signals.topicGroups.map(g => g.tag).sort()).toEqual(['t-a', 't-b']);
    expect(r.materialIds).toHaveLength(3);
  });

  it('lastRunAt 为非法字符串 → 视为从未运行（不炸）', () => {
    const r = evaluateDistillThreshold(oreGroup('t-a', TOPIC_MIN_NEW), { lastRunAt: 'not-a-date', lastConsumedAt: 'not-a-date' }, NOW);
    expect(r.fire).toBe(true);
  });
});

describe('evaluateDistillThreshold — #366 来源限定（topic 信号）', () => {
  it('来源过滤是条目级：同 tag 混源时 system 条目不凑数、不进组', () => {
    const agents = oreGroup('t-a', TOPIC_MIN_NEW);
    const injected = oreGroup('t-a', 5, { origin: 'system' });
    const r = evaluateDistillThreshold([...agents, ...injected], { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r.fire).toBe(true);
    // t-a 组只剩可计的 agent；5 条 system 不计数也不入组
    expect(r.signals.topicGroups.map(g => g.tag)).toEqual(['t-a']);
    expect(new Set(r.signals.topicGroups[0].entryIds)).toEqual(new Set(agents.map(a => a.id)));
    for (const e of injected) expect(r.materialIds).not.toContain(e.id);
    expect(new Set(r.materialIds)).toEqual(new Set(agents.map(a => a.id)));
  });

  it(`白名单来源差一口：${TOPIC_MIN_NEW - 1} 条 agent + 大量 system 同 tag → 不点火`, () => {
    const entries = [
      ...oreGroup('t-a', TOPIC_MIN_NEW - 1),
      ...oreGroup('t-a', 10, { origin: 'system' }),
    ];
    const r = evaluateDistillThreshold(entries, { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r.fire).toBe(false);
    expect(r.reason).toBe('no-signal');
  });

  it('origin 缺省/未知值 → 不参与 topic 计数（fail-closed）', () => {
    const noOrigin = oreGroup('t-a', TOPIC_MIN_NEW - 1).map(e => ({ ...e, origin: undefined }));
    const legacy = oreGroup('t-a', TOPIC_MIN_NEW).map(e => ({ ...e, origin: 'merge' as DistillThresholdEntry['origin'] }));
    const r1 = evaluateDistillThreshold(noOrigin as DistillThresholdEntry[], { lastRunAt: null, lastConsumedAt: null }, NOW);
    const r2 = evaluateDistillThreshold(legacy, { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r1.fire).toBe(false);
    expect(r2.fire).toBe(false);
  });

  it('manual 信号不受来源限定：system 来源过审条目 ≥ MANUAL_MIN_NEW 照常点火', () => {
    const entries = Array.from({ length: MANUAL_MIN_NEW }, (_, i) =>
      entry({ maturity: 'verified', origin: 'system', tags: [`manual-${i}`] }));
    const r = evaluateDistillThreshold(entries, { lastRunAt: null, lastConsumedAt: null }, NOW);
    expect(r.fire).toBe(true);
    expect(r.signals.manualEntryIds).toHaveLength(MANUAL_MIN_NEW);
  });
});
