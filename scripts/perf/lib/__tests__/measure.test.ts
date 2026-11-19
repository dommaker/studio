import { describe, expect, it } from 'vitest';
import { measureAlternating, measureScenarioAlternating, summarizeDiagnostics } from '../measure.js';

describe('measureAlternating', () => {
  it('baseline/current 逐轮交替，并汇总多轮 p50/p95；max 仅保留诊断', async () => {
    const order: string[] = [];
    let currentRound = 0;
    const result = await measureAlternating({
      repeats: 2,
      baseline: async () => { order.push('baseline'); return [10, 20]; },
      current: async () => { order.push('current'); return currentRound++ === 0 ? [20, 30] : [40, 1000]; },
    });
    expect(order).toEqual(['baseline', 'current', 'current', 'baseline']);
    expect(result.baseline.p50).toBe(15);
    expect(result.current.p50).toBe(35);
    expect(result.current.p95).toBeGreaterThan(100);
    expect(result.current.max).toBe(1000);
  });
});

describe('measureScenarioAlternating', () => {
  it('B/C 只交替同端点同冻结快照，不用不同场景冒充 A/B', async () => {
    const calls: Array<{ scenario: string; snapshot: string }> = [];
    const result = await measureScenarioAlternating({
      scenario: '/api/v1/action-center', snapshot: 'frozen-wu-1', repeats: 2,
      measure: async (scenario, snapshot) => {
        calls.push({ scenario, snapshot });
        return [10, 20];
      },
    });
    expect(calls).toEqual([
      { scenario: '/api/v1/action-center', snapshot: 'frozen-wu-1' },
      { scenario: '/api/v1/action-center', snapshot: 'frozen-wu-1' },
      { scenario: '/api/v1/action-center', snapshot: 'frozen-wu-1' },
      { scenario: '/api/v1/action-center', snapshot: 'frozen-wu-1' },
    ]);
    expect(result.baseline.n).toBe(4);
    expect(result.current.n).toBe(4);
  });
});

describe('summarizeDiagnostics', () => {
  it('统一汇总锁等待、事件循环、RSS、读取字节和 parse 行数', () => {
    expect(summarizeDiagnostics({
      lockWaitMs: [1, 3], eventLoopDelayMs: [2, 4], rssBytes: [100, 200],
      readBytes: 1234, parsedLines: 56, cacheMisses: 2,
    })).toEqual({
      lockWaitMs: { p50: 2, p95: 2.9, max: 3 },
      eventLoopDelayMs: { p50: 3, p95: 3.9, max: 4 },
      rssBytes: { start: 100, peak: 200, end: 200 },
      readBytes: 1234, parsedLines: 56, cacheMisses: 2,
    });
  });
});
