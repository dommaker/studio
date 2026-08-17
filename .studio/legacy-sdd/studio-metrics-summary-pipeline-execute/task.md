---
id: "cmq9nbhrt00j2ox1vvve76mht"
goalId: "cmq9nbjee00jmox1vjd5r1a5d"
slug: "studio-metrics-summary-pipeline-execute"
title: "studio metrics summary — 管线执行指标总览"
status: "stale"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["cli", "metrics", "pipeline", "observability"]
createdAt: "2026-06-11T15:21:53.845Z"
updatedAt: "2026-06-11T15:21:55.987Z"
---

# studio metrics summary — 管线执行指标总览

在 CLI metrics 命令下新增 summary 子命令，查询 PipelineRun 表按 phase 分组统计最近 24h 执行数据，输出表格和总览

<!-- TASK_TIER {"tier":"fast","reason":"2 文件改动（metrics.ts + studio-cli.ts），无 schema 变更，无跨模块依赖，复用现有 groupBy 模式和 formatTable 工具"} -->

## Contract Tests

### __tests__/metrics-summary.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    pipelineRun: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  formatTable: vi.fn((data: unknown[], headers?: string[]) => {
    if (!data.length) return '(no data)';
    const keys = headers ?? Object.keys(data[0] as Record<string, unknown>);
    return [keys.join(' | '), ...data.map((r: unknown) => keys.map(k => String((r as Record<string, unknown>)[k] ?? '')).join(' | '))].join('\n');
  }),
}));

import { prisma } from '@dommaker/studio-prisma';
import { getPhaseSummary, formatDuration, printSummary } from '../metrics.js';

describe('formatDuration', () => {
  it('formats 0ms as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds only', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(90000)).toBe('1m30s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3720000)).toBe('1h2m');
  });
});

describe('getPhaseSummary', () => {
  beforeEach(() => {
    vi.mocked(prisma.pipelineRun.groupBy).mockReset();
    vi.mocked(prisma.pipelineRun.findMany).mockReset();
  });

  it('returns empty array when no data', async () => {
    vi.mocked(prisma.pipelineRun.groupBy).mockResolvedValue([]);
    vi.mocked(prisma.pipelineRun.findMany).mockResolvedValue([]);
    const result = await getPhaseSummary();
    expect(result.phases).toEqual([]);
    expect(result.overview.totalRuns).toBe(0);
  });

  it('aggregates phase stats correctly', async () => {
    vi.mocked(prisma.pipelineRun.groupBy).mockResolvedValue([
      { phase: 'analyst', _count: 10, _avg: { durationMs: 5000 }, _sum: { inputTokens: 10000, outputTokens: 3000, cacheHitTokens: 2000 } },
      { phase: 'executor', _count: 5, _avg: { durationMs: 15000 }, _sum: { inputTokens: 20000, outputTokens: 8000, cacheHitTokens: 5000 } },
    ] as unknown as Awaited<ReturnType<typeof prisma.pipelineRun.groupBy>>);
    // success count query
    vi.mocked(prisma.pipelineRun.findMany).mockResolvedValue([
      { goalId: 'g1', durationMs: 30000 },
      { goalId: 'g1', durationMs: 20000 },
      { goalId: 'g2', durationMs: 60000 },
    ] as unknown as Awaited<ReturnType<typeof prisma.pipelineRun.findMany>>);
    const result = await getPhaseSummary();
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].phase).toBe('analyst');
    expect(result.phases[0].count).toBe(10);
    expect(result.overview.totalRuns).toBe(15);
    expect(result.overview.totalTokens).toBe(48000); // 10000+3000+2000+20000+8000+5000
  });

  it('computes cache hit rate correctly', async () => {
    vi.mocked(prisma.pipelineRun.groupBy).mockResolvedValue([
      { phase: 'executor', _count: 1, _avg: { durationMs: 1000 }, _sum: { inputTokens: 1000, outputTokens: 500, cacheHitTokens: 500 } },
    ] as unknown as Awaited<ReturnType<typeof prisma.pipelineRun.groupBy>>);
    vi.mocked(prisma.pipelineRun.findMany).mockResolvedValue([]);
    const result = await getPhaseSummary();
    // cacheHitRate = 500 / (1000 + 500) * 100 = 33.3%
    expect(result.phases[0].cacheHitRate).toBeCloseTo(33.3, 0);
  });
});

describe('printSummary', () => {
  it('formats table with phase data', () => {
    const phases = [
      { phase: 'analyst', count: 10, successRate: 90, avgDurationMs: 5000, totalTokens: 15000, cacheHitRate: 20 },
    ];
    const overview = { totalRuns: 10, totalTokens: 15000, avgGoalDurationMs: 60000 };
    const output = printSummary(phases, overview);
    expect(output).toContain('analyst');
    expect(output).toContain('90.0%');
    expect(output).toContain('1m0s');
  });

  it('shows no-data message for empty phases', () => {
    const output = printSummary([], { totalRuns: 0, totalTokens: 0, avgGoalDurationMs: 0 });
    expect(output).toContain('No pipeline runs in the last 24h');
  });
});

```