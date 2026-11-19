import { describe, expect, it } from 'vitest';
import { DEFAULT_SCALE, evaluateScaleReport, parseScaleArgs, runWorkerPool, type ScaleReport } from '../scale.js';

const CORRECTNESS = [
  'updateMetadata side effects', 'claim single winner', 'lease flush persisted', 'token ledger totals',
  'AgentLoop step persisted', 'knowledge injected marker', 'role observation shared', 'scale matrix visible',
  'SSE all clients received', 'action-center state items',
];
const LATENCY = [
  'updateMetadata', 'claim concurrent roles', 'lease flush', 'token ledger write', 'role thundering herd',
  'knowledge injection', 'action-center concurrent', 'overview concurrent', 'real AgentLoop step',
];

function metric(name: string) {
  return { name, n: 30, minSamples: 30, p50: 5, p95: 20, max: 900, budgetP50Ms: 50, budgetP95Ms: 100 };
}

function report(): ScaleReport {
  return {
    version: 1,
    scale: { ...DEFAULT_SCALE },
    correctness: CORRECTNESS.map(name => ({ name, ok: true })),
    latency: LATENCY.map(metric),
    soak: [{ ...metric('SSE sustained'), budgetP50Ms: 50, budgetP95Ms: 100 }],
    diagnostics: {
      'action-center concurrent': {
        lockWaitMs: { p50: 1, p95: 2, max: 3 }, eventLoopDelayMs: { p50: 1, p95: 2, max: 3 },
        rssBytes: { start: 1, peak: 2, end: 2 }, readBytes: 100, parsedLines: 4, cacheMisses: 1,
      },
    },
    observations: ['max is diagnostic only'],
  };
}

describe('runWorkerPool', () => {
  it('固定 worker 数，每 worker 串行 runs，不把 concurrency×runs 全同时打出', async () => {
    let active = 0;
    let peak = 0;
    const running = new Map<number, number>();
    const result = await runWorkerPool(2, 3, async (worker, iteration) => {
      expect(running.has(worker)).toBe(false);
      running.set(worker, iteration);
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      running.delete(worker);
      return worker * 10 + iteration;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([0, 1, 2, 10, 11, 12]);
  });
});

describe('parseScaleArgs', () => {
  it('默认覆盖非空五域规模、多轮和并发', () => {
    expect(parseScaleArgs([])).toMatchObject({ repeats: 3, runs: 10, scale: DEFAULT_SCALE });
    for (const key of ['workUnits', 'events', 'messages', 'notifications', 'knowledge', 'roles', 'httpConcurrency', 'sseClients'] as const) {
      expect(DEFAULT_SCALE[key]).toBeGreaterThan(0);
    }
  });
});

describe('evaluateScaleReport', () => {
  it('correctness/latency/soak 分类；max 不判红', () => {
    expect(evaluateScaleReport(report())).toEqual({ correctness: [], latency: [], soak: [] });
  });

  it('副作用失败归 correctness，绝对预算失败按场景归类', () => {
    const input = report();
    input.correctness[0].ok = false;
    input.latency[6].p95 = 101;
    input.soak[0].p95 = 101;
    expect(evaluateScaleReport(input)).toEqual({
      correctness: ['updateMetadata side effects'], latency: ['action-center concurrent'], soak: ['SSE sustained'],
    });
  });

  it('未形成基线的新场景超预算只诊断，correctness 不放松', () => {
    const input = report();
    input.latency[6].hard = false;
    input.latency[6].p95 = 10_000;
    input.correctness[1].ok = false;
    expect(evaluateScaleReport(input)).toEqual({ correctness: ['claim single winner'], latency: [], soak: [] });
  });

  it('样本不足和必需指标缺失 fail-closed', () => {
    const input = report();
    input.latency[6].n = 2;
    input.latency = input.latency.filter(row => row.name !== 'overview concurrent');
    input.correctness = input.correctness.filter(row => row.name !== 'role observation shared');
    expect(evaluateScaleReport(input).correctness).toEqual([
      'samples:action-center concurrent', 'missing:overview concurrent', 'missing:role observation shared',
    ]);
  });

  it('规模矩阵缺域即拒绝出绿', () => {
    const input = report();
    input.scale.messages = 0;
    expect(() => evaluateScaleReport(input)).toThrow(/规模矩阵.*messages/);
  });
});
