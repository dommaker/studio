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

// ── #411：分段归因（读口 / harness / exec / 其他）───

function seg(kind: 'exec' | 'harness', name: string, ms: number) {
  return { kind, name, ms };
}

const workerSegments: WorkerResult = {
  scale: '1x',
  meta: { rounds: 3, templateWorkUnits: 45, eventLines: 100, agentDirs: 10 },
  rounds: [
    {
      loop: 'monitor-round', round: 0, wallMs: 300,
      events: [ev('wu-index', { hit: false, readParseMs: 10 })],
      segments: [seg('exec', 'git worktree prune', 30), seg('harness', 'FileKnowledgeStore.list', 50)],
    },
    {
      loop: 'monitor-round', round: 1, wallMs: 50,
      events: [ev('wu-index')],
      segments: [
        seg('exec', 'git worktree prune', 10),
        seg('exec', 'npx harness update-user-model', 5),
        seg('harness', 'FileKnowledgeStore.list', 8),
      ],
    },
    {
      loop: 'monitor-round', round: 2, wallMs: 70,
      events: [ev('wu-index')],
      segments: [
        seg('exec', 'git worktree prune', 20),
        seg('exec', 'npx harness update-user-model', 5),
        seg('harness', 'KnowledgeLinter.run', 4),
      ],
    },
  ],
};

describe('summarize 分段归因（#411）', () => {
  it('exec/harness 段按轮合计取 P50；exec 按命令名分列区分两类命令', () => {
    const row = summarize([workerSegments]).rows.find(r => r.loop === 'monitor-round')!;
    expect(row).toBeDefined();

    // exec 每轮合计 [15, 25] → nearest-rank P50 = 15
    expect(row.warm.execMsP50).toBeCloseTo(15, 5);
    // harness 每轮合计 [8, 4] → sorted [4, 8] → P50 = 4
    expect(row.warm.harnessMsP50).toBeCloseTo(4, 5);

    // exec 按命令名：git worktree prune 每轮 [10,20] → P50=10；npx harness 每轮 [5,5] → P50=5
    expect(row.warm.execByName['git worktree prune']).toMatchObject({ countPerRound: 1, msP50: 10 });
    expect(row.warm.execByName['npx harness update-user-model']).toMatchObject({ countPerRound: 1, msP50: 5 });
  });

  it('无 segments 的旧协议轮次（可省字段）聚合为 0，不炸', () => {
    const row = summarize([worker1x]).rows.find(r => r.loop === 'monitor-round' && r.scale === '1x')!;
    expect(row.warm.execMsP50).toBe(0);
    expect(row.warm.harnessMsP50).toBe(0);
    expect(row.warm.execByName).toEqual({});
  });
});

describe('renderMarkdown 分段归因（#411）', () => {
  it('报告含分段归因表（读口/harness/exec/其他）与 exec 命令明细，口径说明更新', () => {
    const summary = summarize([workerSegments]);
    const md = renderMarkdown(summary, {
      generatedAt: '2026-09-01T00:00:00.000Z',
      roundsPerLoop: 3,
      gaps: [],
      measurementCode: [],
      recommendation: '',
    });

    expect(md).toContain('分段归因');
    expect(md).toContain('harness');
    // exec 命令明细区分两类命令
    expect(md).toContain('git worktree prune');
    expect(md).toContain('npx harness update-user-model');
    // 口径说明覆盖新分段定义（harness 自耗时 = 扣除嵌套读口）
    expect(md).toMatch(/harness[^\n]*调用级/);
    expect(md).toMatch(/上报自耗时[^\n]*读口耗时/);
    expect(md).toMatch(/exec[^\n]*子进程/);
    expect(md).toContain('并发口径注意');
  });

  it('无 exec 事件时不输出 exec 命令明细空表', () => {
    const summary = summarize([worker1x]);
    const md = renderMarkdown(summary, {
      generatedAt: '2026-09-01T00:00:00.000Z',
      roundsPerLoop: 3,
      gaps: [],
      measurementCode: [],
      recommendation: '',
    });
    expect(md).not.toContain('exec 命令明细');
  });
});
