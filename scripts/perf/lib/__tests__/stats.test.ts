import { describe, it, expect } from 'vitest';
import { percentile, summarize } from '../stats.js';

describe('percentile', () => {
  it('空样本返回 0', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('单样本任意分位返回该值', () => {
    expect(percentile([4.2], 50)).toBeCloseTo(4.2);
    expect(percentile([4.2], 95)).toBeCloseTo(4.2);
  });

  it('线性插值：偶数样本 p50 取中两点均值', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5);
  });

  it('p95 靠近高端', () => {
    const samples = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50
    expect(percentile(samples, 95)).toBeCloseTo(47.55);
  });

  it('输入未排序也能正确（内部排序，不改原数组）', () => {
    const samples = [5, 1, 3];
    expect(percentile(samples, 50)).toBeCloseTo(3);
    expect(samples).toEqual([5, 1, 3]);
  });
});

describe('summarize', () => {
  it('给出 n/min/p50/p95/max，保留 1 位小数', () => {
    const s = summarize([1.04, 2.06, 3.0]);
    expect(s).toEqual({ n: 3, min: 1, p50: 2.1, p95: 2.9, max: 3 });
  });

  it('空样本全零', () => {
    expect(summarize([])).toEqual({ n: 0, min: 0, p50: 0, p95: 0, max: 0 });
  });
});
