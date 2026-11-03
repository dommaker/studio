import { describe, it, expect } from 'vitest';
import { parseBenchArgs, toMetric } from '../bench.js';

describe('parseBenchArgs', () => {
  it('缺省全空（由 runBench 落默认值）', () => {
    expect(parseBenchArgs([])).toEqual({});
  });

  it('解析全部选项', () => {
    expect(parseBenchArgs(['--seed', '500', '--runs', '30', '--sse-rounds', '10', '--cold-runs', '2', '--repeats', '3', '--out', '/tmp/x.json', '--quiet'])).toEqual({
      seed: 500,
      runs: 30,
      sseRounds: 10,
      coldRuns: 2,
      repeats: 3,
      out: '/tmp/x.json',
      quiet: true,
    });
  });

  it('未知参数抛错', () => {
    expect(() => parseBenchArgs(['--bogus'])).toThrow('未知参数');
  });
});

describe('toMetric', () => {
  it('TimedResult → EndpointMetric（p50/p95/max 取自 summarize，状态码透传）', () => {
    const m = toMetric('health', 'GET', '/api/v1/health', {
      samples: [1, 2, 3, 4, 5],
      statusCounts: { '200': 5 },
    });
    expect(m).toEqual({ name: 'health', method: 'GET', path: '/api/v1/health', statusCounts: { '200': 5 }, p50: 3, p95: 4.8, max: 5 });
  });
});
