import { describe, it, expect } from 'vitest';
import { meanAndStddev, zScoreTest, rollingBaseline, detectTrend, detectDelta, percentile } from '../anomaly-detector';

describe('meanAndStddev', () => {
  it('computes mean and stddev for normal input', () => {
    const result = meanAndStddev([1, 2, 3, 4, 5]);
    expect(result.mean).toBeCloseTo(3);
    expect(result.stddev).toBeCloseTo(1.414, 1);
  });

  it('returns {mean:0, stddev:0} for empty array', () => {
    const result = meanAndStddev([]);
    expect(result.mean).toBe(0);
    expect(result.stddev).toBe(0);
  });

  it('filters NaN values', () => {
    const result = meanAndStddev([1, NaN, 3]);
    expect(result.mean).toBeCloseTo(2);
  });

  it('returns {mean:v, stddev:0} for single element', () => {
    const result = meanAndStddev([5]);
    expect(result.mean).toBe(5);
    expect(result.stddev).toBe(0);
  });
});

describe('zScoreTest', () => {
  it('detects anomaly when |zScore| > 2', () => {
    const result = zScoreTest(5, { mean: 0, stddev: 2 });
    expect(result.zScore).toBeCloseTo(2.5);
    expect(result.isAnomaly).toBe(true);
    expect(result.severity).toBe('warning');
  });

  it('returns normal when |zScore| <= 2', () => {
    const result = zScoreTest(1, { mean: 0, stddev: 2 });
    expect(result.zScore).toBeCloseTo(0.5);
    expect(result.isAnomaly).toBe(false);
    expect(result.severity).toBe('normal');
  });

  it('critical when |zScore| > 3', () => {
    const result = zScoreTest(7, { mean: 0, stddev: 2 });
    expect(result.zScore).toBeCloseTo(3.5);
    expect(result.isAnomaly).toBe(true);
    expect(result.severity).toBe('critical');
  });

  it('returns normal when stddev is 0', () => {
    const result = zScoreTest(5, { mean: 5, stddev: 0 });
    expect(result.isAnomaly).toBe(false);
    expect(result.severity).toBe('normal');
  });
});

describe('rollingBaseline', () => {
  it('returns stats for last windowSize elements', () => {
    const result = rollingBaseline([1, 2, 3, 4, 5], 3);
    expect(result.mean).toBeCloseTo(4);
    expect(result.stddev).toBeCloseTo(0.816, 1);
  });

  it('uses full array when windowSize > length', () => {
    const result = rollingBaseline([1, 2], 10);
    expect(result.mean).toBeCloseTo(1.5);
  });
});

describe('detectTrend', () => {
  it('detects upward trend over consecutive days', () => {
    const result = detectTrend([1, 2, 3, 4], 3);
    expect(result.direction).toBe('up');
    expect(result.consecutiveDays).toBe(4);
  });

  it('detects downward trend', () => {
    const result = detectTrend([4, 3, 2, 1], 3);
    expect(result.direction).toBe('down');
    expect(result.consecutiveDays).toBe(4);
  });

  it('returns stable when no consecutive trend', () => {
    const result = detectTrend([1, 2, 1, 2], 3);
    expect(result.direction).toBe('stable');
    expect(result.consecutiveDays).toBe(0);
  });

  it('returns stable for array shorter than 2', () => {
    const result = detectTrend([5], 3);
    expect(result.direction).toBe('stable');
    expect(result.consecutiveDays).toBe(0);
  });
});

describe('detectDelta', () => {
  it('detects large single-day change', () => {
    const result = detectDelta(15, 10, 0.5);
    expect(result.deltaRatio).toBeCloseTo(0.5);
    expect(result.isAnomaly).toBe(true);
  });

  it('returns false for small change', () => {
    const result = detectDelta(11, 10, 0.5);
    expect(result.deltaRatio).toBeCloseTo(0.1);
    expect(result.isAnomaly).toBe(false);
  });

  it('handles previous=0 with epsilon', () => {
    const result = detectDelta(5, 0, 0.5);
    expect(result.isAnomaly).toBe(true);
    expect(result.deltaRatio).toBeGreaterThan(0);
  });
});

describe('percentile', () => {
  it('returns median for p=50', () => {
    const result = percentile([1, 2, 3, 4, 5], 50);
    expect(result).toBe(3);
  });

  it('returns 0 for empty array', () => {
    const result = percentile([], 50);
    expect(result).toBe(0);
  });

  it('returns NaN for invalid p', () => {
    expect(percentile([1,2,3], -1)).toBeNaN();
    expect(percentile([1,2,3], 101)).toBeNaN();
  });
});
