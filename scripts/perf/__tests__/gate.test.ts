import { describe, it, expect } from 'vitest';
import { parseGateArgs } from '../gate.js';

describe('parseGateArgs', () => {
  it('缺省全空（compareReports 落默认值）', () => {
    expect(parseGateArgs([])).toEqual({});
  });

  it('解析阈值与地板', () => {
    expect(parseGateArgs(['--threshold', '25', '--min-delta-ms', '3', '--cold-start-min-delta-ms', '800'])).toEqual({
      thresholdPct: 25,
      minDeltaMs: 3,
      coldStartMinDeltaMs: 800,
    });
  });

  it('未知参数抛错', () => {
    expect(() => parseGateArgs(['--seed', '5'])).toThrow('未知参数');
  });
});
