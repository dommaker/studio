import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCompareArgs, runCompare } from '../compare.js';
import type { BenchReport } from '../lib/report.js';

function report(p95: number): BenchReport {
  return {
    version: 1,
    meta: { commit: 'x', node: 'v22', date: '2026-10-08', seed: 0, runs: 50 },
    coldStart: { runs: [2000, 2100, 1900] },
    endpoints: [{ name: 'health', method: 'GET', path: '/api/v1/health', statusCounts: { '200': 50 }, p50: p95 / 2, p95, max: p95 }],
  };
}

describe('parseCompareArgs', () => {
  it('两个位置参数 + 阈值选项', () => {
    expect(parseCompareArgs(['a.json', 'b.json', '--threshold', '30', '--min-delta-ms', '2', '--cold-start-min-delta-ms', '500'])).toEqual({
      baseline: 'a.json',
      current: 'b.json',
      opts: { thresholdPct: 30, minDeltaMs: 2, coldStartMinDeltaMs: 500 },
    });
  });

  it('位置参数不足抛错', () => {
    expect(() => parseCompareArgs(['only.json'])).toThrow('用法');
  });
});

describe('runCompare', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-compare-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, r: BenchReport): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(r));
    return p;
  }

  it('无回归 → 0', () => {
    expect(runCompare([write('a.json', report(10)), write('b.json', report(10))])).toBe(0);
  });

  it('回归 >20% → 1', () => {
    expect(runCompare([write('a.json', report(50)), write('b.json', report(100))])).toBe(1);
  });

  it('用法错误 → 2', () => {
    expect(runCompare([])).toBe(2);
  });
});
