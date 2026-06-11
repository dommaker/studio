/**
 * Metrics tests — parseClaudeUsage (pure) + printComparison (formatting)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    pipelineRun: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/cli', () => ({
  formatTable: vi.fn((data: any[]) => {
    if (!data.length) return '(no data)';
    const keys = Object.keys(data[0]);
    const header = keys.join(' | ');
    const rows = data.map((r: any) => keys.map(k => String(r[k])).join(' | '));
    return [header, ...rows].join('\n');
  }),
}));

import { parseClaudeUsage, printComparison, formatDuration, getPhaseSummary, printSummary, type MetricEntry, type PhaseSummaryRow, type SummaryOverview } from '../metrics.js';
import { prisma } from '@dommaker/studio-prisma';

describe('parseClaudeUsage', () => {
  it('parses JSON usage object', () => {
    const stdout = JSON.stringify({
      result: 'ok',
      usage: { input_tokens: 1500, output_tokens: 800, cache_read_input_tokens: 300 },
    });
    const result = parseClaudeUsage(stdout);
    expect(result).toEqual({
      inputTokens: 1500,
      outputTokens: 800,
      cacheHitTokens: 300,
    });
  });

  it('handles missing usage fields gracefully', () => {
    const stdout = JSON.stringify({ result: 'ok' });
    const result = parseClaudeUsage(stdout);
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
    });
  });

  it('falls back to regex parsing for non-JSON output', () => {
    const stdout = 'Some output with input_tokens: 2000 and output_tokens: 600 and cache_read_input_tokens: 100';
    const result = parseClaudeUsage(stdout);
    expect(result).toEqual({
      inputTokens: 2000,
      outputTokens: 600,
      cacheHitTokens: 100,
    });
  });

  it('returns zeros for unparseable output', () => {
    const result = parseClaudeUsage('no numbers here');
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
    });
  });

  it('uses cache_creation_input_tokens as fallback', () => {
    const stdout = JSON.stringify({
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 25 },
    });
    const result = parseClaudeUsage(stdout);
    expect(result.cacheHitTokens).toBe(25);
  });
});

describe('printComparison', () => {
  const base: MetricEntry = {
    source: 'pipeline',
    phase: 'executor',
    taskName: 'test-task',
    model: 'claude-sonnet-4-6',
    inputTokens: 5000,
    outputTokens: 2000,
    cacheHitTokens: 1000,
    durationMs: 15000,
    success: true,
  };

  it('formats comparison table with both entries', () => {
    const output = printComparison(base, { ...base, source: 'window', durationMs: 20000 });
    expect(output).toContain('管线 vs 窗口 对比');
    expect(output).toContain('claude-sonnet-4-6');
    expect(output).toContain('15.0s');
    expect(output).toContain('20.0s');
  });

  it('handles missing entries with dashes', () => {
    const output = printComparison(undefined, undefined);
    expect(output).toContain('-');
    expect(output).toContain('管线 vs 窗口 对比');
  });

  it('formats tokens in K units', () => {
    const output = printComparison(base, undefined);
    expect(output).toContain('5.0K');
    expect(output).toContain('2.0K');
    expect(output).toContain('1.0K');
  });

  it('formats success status', () => {
    const output = printComparison(
      { ...base, success: true, testPassed: true, lintPassed: false },
      { ...base, source: 'window', success: false },
    );
    // success true shows checkmark, false shows X
    expect(output).toContain('✅');
    expect(output).toContain('❌');
  });

  it('formats cache hit rate', () => {
    const output = printComparison(base, undefined);
    // 1000/5000 = 20.0%
    expect(output).toContain('20.0%');
  });
});

describe('formatDuration', () => {
  it('formats 0ms as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds < 60', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59000)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(90000)).toBe('1m30s');
    expect(formatDuration(3599000)).toBe('59m59s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3600000)).toBe('1h');
    expect(formatDuration(5400000)).toBe('1h30m');
    expect(formatDuration(7200000)).toBe('2h');
    expect(formatDuration(7260000)).toBe('2h1m');
  });

  it('handles negative/NaN defensively', () => {
    expect(formatDuration(-100)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(Infinity)).toBe('0s');
  });
});

describe('getPhaseSummary', () => {
  it('returns empty for no data', async () => {
    vi.mocked(prisma.pipelineRun.groupBy).mockResolvedValueOnce([]);
    const result = await getPhaseSummary();
    expect(result.phases).toEqual([]);
    expect(result.overview.totalExecutions).toBe(0);
  });

  it('returns phase summary with correct calculations', async () => {
    vi.mocked(prisma.pipelineRun.groupBy)
      .mockResolvedValueOnce([
        {
          phase: 'executor',
          _count: { _all: 10 },
          _avg: { durationMs: 5000 },
          _sum: { inputTokens: 10000, outputTokens: 3000, cacheHitTokens: 2000 },
        },
        {
          phase: 'analyst',
          _count: { _all: 5 },
          _avg: { durationMs: 3000 },
          _sum: { inputTokens: 5000, outputTokens: 1000, cacheHitTokens: 0 },
        },
      ] as any)
      .mockResolvedValueOnce([
        { phase: 'executor', _count: { _all: 8 } },
        { phase: 'analyst', _count: { _all: 3 } },
      ] as any);

    vi.mocked(prisma.pipelineRun.findMany).mockResolvedValueOnce([
      { goalId: 'g1', durationMs: 10000 },
      { goalId: 'g1', durationMs: 20000 },
      { goalId: 'g2', durationMs: 5000 },
    ] as any);

    const result = await getPhaseSummary();

    expect(result.phases).toHaveLength(2);
    // executor: 8/10 = 80%
    expect(result.phases[0].successRate).toBeCloseTo(0.8);
    // cacheHitRate: 2000/(10000+2000) = 16.67%
    expect(result.phases[0].cacheHitRate).toBeCloseTo(2000 / 12000);
    // totalTokens = inputTokens + outputTokens
    expect(result.phases[0].totalTokens).toBe(13000);

    // analyst: 3/5 = 60%
    expect(result.phases[1].successRate).toBeCloseTo(0.6);
    // cacheHitRate: 0/(5000+0) = 0%
    expect(result.phases[1].cacheHitRate).toBe(0);

    // overview
    expect(result.overview.totalExecutions).toBe(15);
    expect(result.overview.totalTokens).toBe(19000); // 13000 + 6000
    // avgGoalDuration: g1 avg=15000, g2=5000, overall avg=10000
    expect(result.overview.avgGoalDurationMs).toBeCloseTo(10000);
  });

  it('handles 100% cache hit rate', async () => {
    vi.mocked(prisma.pipelineRun.groupBy)
      .mockResolvedValueOnce([{
        phase: 'full',
        _count: { _all: 1 },
        _avg: { durationMs: 1000 },
        _sum: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 1000 },
      }] as any)
      .mockResolvedValueOnce([{ phase: 'full', _count: { _all: 1 } }] as any);
    vi.mocked(prisma.pipelineRun.findMany).mockResolvedValueOnce([] as any);

    const result = await getPhaseSummary();
    // 1000/(0+1000) = 100%
    expect(result.phases[0].cacheHitRate).toBe(1);
  });

  it('handles 0% cache hit rate', async () => {
    vi.mocked(prisma.pipelineRun.groupBy)
      .mockResolvedValueOnce([{
        phase: 'review',
        _count: { _all: 3 },
        _avg: { durationMs: 2000 },
        _sum: { inputTokens: 5000, outputTokens: 1000, cacheHitTokens: 0 },
      }] as any)
      .mockResolvedValueOnce([{ phase: 'review', _count: { _all: 2 } }] as any);
    vi.mocked(prisma.pipelineRun.findMany).mockResolvedValueOnce([] as any);

    const result = await getPhaseSummary();
    expect(result.phases[0].cacheHitRate).toBe(0);
  });
});

describe('printSummary', () => {
  it('returns no data message for empty phases', () => {
    const result = printSummary([], { totalExecutions: 0, totalTokens: 0, avgGoalDurationMs: 0 });
    expect(result).toBe('No pipeline runs in the last 24h');
  });

  it('formats summary table with overview', () => {
    const phases: PhaseSummaryRow[] = [
      { phase: 'executor', count: 10, successRate: 0.8, avgDurationMs: 5000, totalTokens: 13000, cacheHitRate: 0.167 },
    ];
    const overview: SummaryOverview = { totalExecutions: 10, totalTokens: 13000, avgGoalDurationMs: 5000 };
    const result = printSummary(phases, overview);
    expect(result).toContain('executor');
    expect(result).toContain('80.0%');
    expect(result).toContain('5s');
    expect(result).toContain('13.0K');
    expect(result).toContain('16.7%');
    expect(result).toContain('Total: 10 executions');
  });

  it('formats total tokens and avg goal duration in overview', () => {
    const phases: PhaseSummaryRow[] = [
      { phase: 'analyst', count: 5, successRate: 0.6, avgDurationMs: 3000, totalTokens: 6000, cacheHitRate: 0 },
    ];
    const overview: SummaryOverview = { totalExecutions: 5, totalTokens: 6000, avgGoalDurationMs: 90000 };
    const result = printSummary(phases, overview);
    expect(result).toContain('6.0K');
    expect(result).toContain('1m30s');
  });
});
