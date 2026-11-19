/**
 * 测量统计纯函数（#673）——与 docs/architecture/performance-baseline.md §2 同口径：
 * 串行采样 → p50/p95/max。percentile 用线性插值（type 7）。
 */

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function summarize(samples: number[]): Summary {
  if (samples.length === 0) return { n: 0, min: 0, p50: 0, p95: 0, max: 0 };
  return {
    n: samples.length,
    min: round1(Math.min(...samples)),
    p50: round1(percentile(samples, 50)),
    p95: round1(percentile(samples, 95)),
    max: round1(Math.max(...samples)),
  };
}
