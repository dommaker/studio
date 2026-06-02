/**
 * Metrics tests — parseClaudeUsage (pure) + printComparison (formatting)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    pipelineRun: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseClaudeUsage, printComparison, type MetricEntry } from '../metrics.js';

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
