import { describe, expect, it } from 'vitest';
import { browserSamplePlan, evaluateBrowserReport, parseBrowserArgs, type BrowserReport } from '../browser.js';

const CORRECTNESS = [
  'long history rendered', 'long history anchor', 'continuous SSE received', 'detail visits completed',
  'heap measurement valid', 'web vitals captured',
];

const report: BrowserReport = {
  version: 1,
  matrix: { channels: 100, messages: 2000, sseEvents: 50, detailVisits: 1000 },
  correctness: CORRECTNESS.map(name => ({ name, ok: true })),
  latency: [{ name: 'LCP', n: 20, minSamples: 20, p50: 500, p95: 900, max: 3000, budgetP50Ms: 1000, budgetP95Ms: 2000 }],
  soak: [{ name: 'INP', n: 20, minSamples: 20, p50: 40, p95: 100, max: 900, budgetP50Ms: 100, budgetP95Ms: 200 }],
  diagnostics: {
    longTasks: { p50: 10, p95: 50, max: 700 }, droppedFrames: 2,
    heapBytes: { start: 100, afterGc: 130, peak: 200 }, retainedChannelKeys: 8,
    completedChannelVisits: 100, completedDetailVisits: 1000, historyAnchor: true,
  },
};

describe('parseBrowserArgs', () => {
  it('复用 PERF-06 有界矩阵且默认 repeats×runs', () => {
    expect(parseBrowserArgs([])).toMatchObject({ repeats: 3, runs: 3 });
  });
});

describe('browserSamplePlan', () => {
  it('完整 soak 仅一次，LCP/INP 至少20个轻量重复，不重复1000详情', () => {
    expect(browserSamplePlan({ repeats: 3, runs: 3 })).toEqual({ fullSoakRounds: 1, lightRounds: 19, totalRounds: 20 });
    expect(browserSamplePlan({ repeats: 2, runs: 3 })).toEqual({ fullSoakRounds: 1, lightRounds: 19, totalRounds: 20 });
  });
});

describe('evaluateBrowserReport', () => {
  it('长历史/SSE/详情完成是 correctness；LCP/INP 分别进 latency/soak，max 只诊断', () => {
    expect(evaluateBrowserReport(report)).toEqual({ correctness: [], latency: [], soak: [] });
  });

  it('长会话内存无界或缺 SSE 结果判红', () => {
    const input = structuredClone(report);
    input.diagnostics.retainedChannelKeys = 100;
    input.correctness[2].ok = false;
    expect(evaluateBrowserReport(input)).toEqual({ correctness: ['continuous SSE received'], latency: [], soak: ['retained channel keys'] });
  });

  it('LCP/INP 缺测或样本不足 fail-closed', () => {
    const input = structuredClone(report);
    input.latency = [];
    input.soak[0].n = 1;
    expect(evaluateBrowserReport(input).correctness).toEqual(['missing:LCP', 'samples:INP']);
  });

  it('详情访问数和长历史锚点缺失不能出绿', () => {
    const input = structuredClone(report);
    input.diagnostics.completedDetailVisits = 999;
    input.diagnostics.historyAnchor = false;
    expect(evaluateBrowserReport(input).correctness).toEqual(['long history anchor', 'detail visits completed']);
  });
});

