/**
 * #323 阶段一 bench：轮次聚合 + markdown 报告测试。
 *
 * 计划 §测试：轮次聚合——一轮内多文件多次读的分桶合计正确。
 */
import { describe, it, expect } from 'vitest';
import {
  summarize,
  renderMarkdown,
  type WorkerResult,
} from '../read-metrics-aggregate.js';

function ev(bucket: string, over: Partial<{ op: string; hit: boolean; statMs: number; readParseMs: number; cloneMs: number }> = {}) {
  return { op: 'readJson', bucket, hit: true, statMs: 1, readParseMs: 0, cloneMs: 2, ...over };
}

const worker1x: WorkerResult = {
  scale: '1x',
  meta: { rounds: 3, templateWorkUnits: 45, eventLines: 1097, agentDirs: 746 },
  rounds: [
    // 冷轮（round 0）
    {
      loop: 'monitor-round', round: 0, wallMs: 100,
      events: [ev('wu-index', { hit: false, readParseMs: 10 }), ev('studio-events', { hit: false, readParseMs: 20 })],
    },
    // 暖轮
    {
      loop: 'monitor-round', round: 1, wallMs: 50,
      events: [ev('wu-index'), ev('wu-index'), ev('studio-events', { cloneMs: 4 })],
    },
    {
      loop: 'monitor-round', round: 2, wallMs: 70,
      events: [ev('wu-index'), ev('wu-index'), ev('studio-events', { cloneMs: 8 })],
    },
  ],
};

const worker10x: WorkerResult = {
  scale: '10x',
  meta: { rounds: 2, templateWorkUnits: 45, eventLines: 10970, agentDirs: 7460 },
  rounds: [
    { loop: 'monitor-round', round: 0, wallMs: 500, events: [ev('wu-index', { hit: false, readParseMs: 100 })] },
    { loop: 'monitor-round', round: 1, wallMs: 200, events: [ev('wu-index', { cloneMs: 20 })] },
  ],
};

describe('summarize', () => {
  it('一轮内多文件多次读的分桶合计正确；冷轮单列、暖轮聚合', () => {
    const summary = summarize([worker1x]);
    const row = summary.rows.find(r => r.loop === 'monitor-round' && r.scale === '1x');
    expect(row).toBeDefined();

    // 冷轮
    expect(row!.cold.wallMs).toBe(100);
    expect(row!.cold.readCount).toBe(2);
    expect(row!.cold.readMs).toBeCloseTo(1 + 10 + 2 + 1 + 20 + 2, 5);

    // 暖轮：两轮读次数 [3,3] → P50=3；wall [50,70] → P50 在区间内
    expect(row!.warm.rounds).toBe(2);
    expect(row!.warm.readCountP50).toBe(3);
    expect(row!.warm.wallP50).toBeGreaterThanOrEqual(50);
    expect(row!.warm.wallP50).toBeLessThanOrEqual(70);

    // 分桶：wu-index 每轮 2 次、studio-events 每轮 1 次
    expect(row!.warm.buckets['wu-index'].countPerRound).toBeCloseTo(2, 5);
    expect(row!.warm.buckets['studio-events'].countPerRound).toBeCloseTo(1, 5);
    expect(row!.warm.buckets['wu-index'].hitRatio).toBeCloseTo(1, 5);

    // cloneMs 分布：wu-index [2,2,2,2] → P50=2；studio-events [4,8] → P95=8
    expect(row!.warm.buckets['wu-index'].cloneMsP50).toBeCloseTo(2, 5);
    expect(row!.warm.buckets['studio-events'].cloneMsP95).toBeCloseTo(8, 5);

    // 残差占比 = (wallP50 - readMsP50) / wallP50，readMs 两轮分别 11 与 15（nearest-rank P50=11）
    expect(row!.warm.readMsP50).toBeCloseTo(11, 5);
    expect(row!.warm.residualPct).toBeGreaterThanOrEqual(0);
    expect(row!.warm.residualPct).toBeLessThanOrEqual(100);
  });

  it('多档位按 scale 排序输出', () => {
    const summary = summarize([worker10x, worker1x]);
    const scales = summary.rows.map(r => r.scale);
    expect(scales).toEqual(['1x', '10x']);
    expect(summary.scales).toEqual(['1x', '10x']);
  });
});

describe('renderMarkdown', () => {
  it('输出每循环×规模档的核心表格与缺口/建议占位', () => {
    const summary = summarize([worker1x, worker10x]);
    const md = renderMarkdown(summary, {
      generatedAt: '2026-08-25T00:00:00.000Z',
      roundsPerLoop: 3,
      gaps: ['某循环：无法驱动，理由'],
      measurementCode: ['packages/studio-shared/src/read-metrics.ts（新增）'],
      recommendation: '（建议正文）',
    });

    expect(md).toContain('monitor-round');
    expect(md).toContain('1x');
    expect(md).toContain('10x');
    expect(md).toContain('wu-index');
    expect(md).toContain('studio-events');
    expect(md).toContain('残差');
    expect(md).toContain('冷轮');
    expect(md).toContain('某循环：无法驱动，理由');
    expect(md).toContain('测量代码清单');
    expect(md).toContain('packages/studio-shared/src/read-metrics.ts（新增）');
    expect(md).toContain('（建议正文）');
  });
});
