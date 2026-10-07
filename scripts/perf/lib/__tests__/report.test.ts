import { describe, it, expect } from 'vitest';
import { compareReports, renderMarkdown } from '../report.js';
import type { BenchReport, EndpointMetric } from '../report.js';

function endpoint(name: string, p95: number, overrides: Partial<EndpointMetric> = {}): EndpointMetric {
  return {
    name,
    method: 'GET',
    path: `/api/v1/${name}`,
    statusCounts: { '200': 50 },
    p50: p95 / 2,
    p95,
    max: p95 * 1.5,
    ...overrides,
  };
}

function report(p95s: Record<string, number>, coldStartRuns = [2000, 2500, 2300]): BenchReport {
  return {
    version: 1,
    meta: { commit: 'abc1234', node: 'v22.22.0', date: '2026-10-08', seed: 0, runs: 50 },
    coldStart: { runs: coldStartRuns },
    endpoints: Object.entries(p95s).map(([name, p95]) => endpoint(name, p95)),
  };
}

describe('compareReports', () => {
  it('p95 恶化 >20% 且超绝对地板 → 回归，ok=false', () => {
    const baseline = report({ health: 50, agents: 4 });
    const current = report({ health: 62.5, agents: 4 });
    const r = compareReports(baseline, current);
    expect(r.ok).toBe(false);
    const p95 = r.regressions.find((x) => x.name === 'health' && x.metric === 'p95');
    expect(p95).toMatchObject({ baselineMs: 50, currentMs: 62.5 });
    expect(p95!.changePct).toBeCloseTo(25);
  });

  it('恰好转 20% 不算回归（须严格大于）', () => {
    const baseline = report({ health: 10 });
    const current = report({ health: 12 });
    expect(compareReports(baseline, current).ok).toBe(true);
  });

  it('相对超 20% 但绝对增量低于 min-delta 地板 → 噪声，不算回归', () => {
    const baseline = report({ agents: 4 });
    const current = report({ agents: 4.9 }); // +22.5% 但只 +0.9ms
    expect(compareReports(baseline, current).ok).toBe(true);
  });

  it('min-delta 地板可配置', () => {
    const baseline = report({ agents: 4 });
    const current = report({ agents: 4.9 });
    expect(compareReports(baseline, current, { minDeltaMs: 0.5 }).ok).toBe(false);
  });

  it('阈值可配置', () => {
    const baseline = report({ health: 10 });
    const current = report({ health: 13 });
    expect(compareReports(baseline, current, { thresholdPct: 50 }).ok).toBe(true);
  });

  it('改善（负变化）不报回归', () => {
    const baseline = report({ health: 10 });
    const current = report({ health: 5 });
    const r = compareReports(baseline, current);
    expect(r.ok).toBe(true);
    expect(r.regressions).toHaveLength(0);
  });

  it('冷启动按中位数对比：超 20% 且超 1s 地板才记入', () => {
    const baseline = report({ health: 10 }, [1500, 2600, 2300]); // 中位 2300
    const current = report({ health: 10 }, [3000, 4000, 3500]); // 中位 3500，+52%，+1.2s
    const r = compareReports(baseline, current);
    expect(r.ok).toBe(false);
    expect(r.regressions.some((x) => x.name === 'coldStart.median' && x.metric === 'ms')).toBe(true);
  });

  it('冷启动首轮噪声（run1 独慢）不动中位数 → 不算回归', () => {
    const baseline = report({ health: 10 }, [1500, 2600, 2300]); // 中位 2300
    const current = report({ health: 10 }, [2700, 2300, 1900]); // 中位 2300，run1 +80% 系首轮噪声
    expect(compareReports(baseline, current).ok).toBe(true);
  });

  it('当前报告缺端点 → 报缺失（ok=false，防漏测静默变绿）', () => {
    const baseline = report({ health: 10, agents: 4 });
    const current = report({ health: 10 });
    const r = compareReports(baseline, current);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('agents');
  });

  it('状态码分布变化（出现非 2xx）→ 报回归', () => {
    const baseline = report({ health: 10 });
    const current: BenchReport = {
      ...report({ health: 10 }),
      endpoints: [endpoint('health', 10, { statusCounts: { '200': 48, '500': 2 } })],
    };
    const r = compareReports(baseline, current);
    expect(r.ok).toBe(false);
    expect(r.regressions.some((x) => x.metric === 'status')).toBe(true);
  });

  it('seed 不同 → 拒绝直接对比（口径不同）', () => {
    const baseline = report({ health: 10 });
    const current = report({ health: 10 });
    current.meta.seed = 500;
    expect(() => compareReports(baseline, current)).toThrow(/seed/);
  });
});

describe('renderMarkdown', () => {
  it('输出 baseline 同口径表格（端点 p50/p95/max + 冷启动轮次）', () => {
    const md = renderMarkdown(report({ health: 9.5, agents: 4.7 }, [1500, 2600, 2300]));
    expect(md).toContain('| health |');
    expect(md).toContain('9.5');
    expect(md).toContain('| run1 | 1.5 s |');
    expect(md).toContain('| run2 | 2.6 s |');
    expect(md).toContain('GET /api/v1/health');
  });

  it('标注 seed 与发数口径', () => {
    const md = renderMarkdown(report({ health: 9.5 }));
    expect(md).toContain('50 发串行');
    expect(md).toContain('空数据区');
  });
});
