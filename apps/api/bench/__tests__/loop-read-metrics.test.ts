/**
 * #323 阶段一 bench：父 harness 参数解析测试（纯函数 parseArgs）。
 */
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../loop-read-metrics.js';

describe('parseArgs', () => {
  it('默认：21 轮、1/10/50 三档', () => {
    expect(parseArgs([])).toEqual({ rounds: 21, scales: [1, 10, 50] });
  });

  it('自定义 --rounds 与 --scales', () => {
    expect(parseArgs(['--rounds', '3', '--scales', '1,5'])).toEqual({ rounds: 3, scales: [1, 5] });
  });

  it('单档', () => {
    expect(parseArgs(['--scales', '10'])).toEqual({ rounds: 21, scales: [10] });
  });
});
