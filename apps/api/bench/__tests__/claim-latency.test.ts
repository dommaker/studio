/**
 * #508 走查③ 认领延迟 bench：纯函数（parseArgs/pct/summary）测试。
 * bench 主流程为一次性测量脚本（真 AgentLoop + tmp 合成数据集），不进单测。
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, pct, summary } from '../claim-latency.js';

describe('parseArgs', () => {
  it('默认 5 轮', () => {
    expect(parseArgs([])).toEqual({ rounds: 5 });
  });

  it('自定义 --rounds', () => {
    expect(parseArgs(['--rounds', '3'])).toEqual({ rounds: 3 });
  });
});

describe('pct', () => {
  it('p50 取中位下标，输入无序也能算', () => {
    expect(pct([30, 10, 20], 50)).toBe(20);
  });

  it('p95 不越界（小样本顶到 max）', () => {
    expect(pct([1, 2, 3], 95)).toBe(3);
  });
});

describe('summary', () => {
  it('输出含 n/min/p50/p95/max/mean 六段', () => {
    const s = summary([10, 20, 30]);
    expect(s).toContain('n=3');
    expect(s).toContain('min=10');
    expect(s).toContain('p50=20');
    expect(s).toContain('max=30');
    expect(s).toContain('mean=20.0');
  });
});
