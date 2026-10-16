import { describe, it, expect } from 'vitest';
import { percentile } from '../percentile';

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
