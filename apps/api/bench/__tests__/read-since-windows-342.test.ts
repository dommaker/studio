/**
 * #342 微基准脚本纯函数单测（parseArgs / p50）。
 * 测量主流程依赖真实 ~/.studio 模板与 synthesizeDataset，不在单测覆盖范围（一次性脚本）。
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, p50 } from '../read-since-windows-342.js';

describe('parseArgs', () => {
  it('缺省 runs=10 / scale=50', () => {
    expect(parseArgs([])).toEqual({ runs: 10, scale: 50 });
  });

  it('解析 --runs / --scale 覆盖', () => {
    expect(parseArgs(['--runs', '3', '--scale', '5'])).toEqual({ runs: 3, scale: 5 });
  });
});

describe('p50', () => {
  it('奇数个取排序中位', () => {
    expect(p50([3, 1, 2])).toBe(2);
  });

  it('偶数个取上中位；不改原数组', () => {
    const xs = [4, 1, 3, 2];
    expect(p50(xs)).toBe(3);
    expect(xs).toEqual([4, 1, 3, 2]);
  });
});
