import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock os module before importing the module under test
vi.mock('os', () => ({
  freemem: vi.fn(),
  totalmem: vi.fn(),
  loadavg: vi.fn(),
  cpus: vi.fn(() => [{ model: 'test' }, { model: 'test' }, { model: 'test' }, { model: 'test' }]),
}));

import { getDispatchStrategy, getAvailableSlots, updateDispatchOutcome } from '../concurrency-control';
import * as os from 'os';

const mockFreemem = vi.mocked(os.freemem);
const mockTotalmem = vi.mocked(os.totalmem);
const mockLoadavg = vi.mocked(os.loadavg);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDispatchStrategy', () => {
  it('returns normal when total < 5 (insufficient samples)', () => {
    expect(getDispatchStrategy(4, 4)).toBe('normal');
    expect(getDispatchStrategy(3, 3)).toBe('normal');
    expect(getDispatchStrategy(0, 0)).toBe('normal');
  });

  it('returns conservative when failRate > 0.5 and total >= 5', () => {
    expect(getDispatchStrategy(4, 6)).toBe('conservative');
    expect(getDispatchStrategy(3, 5)).toBe('conservative');
  });

  it('returns normal when failRate = 0.5 (threshold not exceeded)', () => {
    expect(getDispatchStrategy(5, 10)).toBe('normal');
    expect(getDispatchStrategy(3, 6)).toBe('normal');
  });

  it('returns normal when failRate < 0.5', () => {
    expect(getDispatchStrategy(2, 6)).toBe('normal');
    expect(getDispatchStrategy(1, 10)).toBe('normal');
  });
});

describe('getAvailableSlots', () => {
  it('returns 1 slot when freeMem < 15%', () => {
    mockTotalmem.mockReturnValue(16_000_000_000); // 16GB
    mockFreemem.mockReturnValue(2_000_000_000); // 2GB = 12.5%
    mockLoadavg.mockReturnValue([0.5, 0.5, 0.5]);

    expect(getAvailableSlots()).toBe(1);
  });

  it('returns 2 slots when freeMem < 30%', () => {
    mockTotalmem.mockReturnValue(16_000_000_000);
    mockFreemem.mockReturnValue(4_000_000_000); // 25%
    mockLoadavg.mockReturnValue([0.5, 0.5, 0.5]);

    expect(getAvailableSlots()).toBe(2);
  });

  it('returns 2 slots when load > 0.9', () => {
    mockTotalmem.mockReturnValue(16_000_000_000);
    mockFreemem.mockReturnValue(8_000_000_000); // 50% — memory fine
    mockLoadavg.mockReturnValue([3.8, 3.0, 2.5]); // 3.8/4 = 0.95 > 0.9

    expect(getAvailableSlots()).toBe(2);
  });

  it('returns 5 slots when resources are sufficient', () => {
    mockTotalmem.mockReturnValue(16_000_000_000);
    mockFreemem.mockReturnValue(8_000_000_000); // 50%
    mockLoadavg.mockReturnValue([0.5, 0.5, 0.5]);

    expect(getAvailableSlots()).toBe(5);
  });

  it('respects maxCap constraint', () => {
    mockTotalmem.mockReturnValue(16_000_000_000);
    mockFreemem.mockReturnValue(8_000_000_000); // 50% → would be 5
    mockLoadavg.mockReturnValue([0.5, 0.5, 0.5]);

    expect(getAvailableSlots(2)).toBe(2);
    expect(getAvailableSlots(1)).toBe(1);
  });

  it('maxCap applies even when resource-based slots are lower', () => {
    mockTotalmem.mockReturnValue(16_000_000_000);
    mockFreemem.mockReturnValue(2_000_000_000); // 12.5% → would be 1
    mockLoadavg.mockReturnValue([0.5, 0.5, 0.5]);

    expect(getAvailableSlots(3)).toBe(1); // min(1, 3) = 1
  });
});

describe('updateDispatchOutcome', () => {
  it('does not increment failures on success', () => {
    const result = updateDispatchOutcome({ failures: 2, total: 10 }, true);
    expect(result).toEqual({ failures: 2, total: 11 });
  });

  it('increments failures on failure', () => {
    const result = updateDispatchOutcome({ failures: 2, total: 10 }, false);
    expect(result).toEqual({ failures: 3, total: 11 });
  });

  it('caps total at 20 (sliding window)', () => {
    const result = updateDispatchOutcome({ failures: 10, total: 20 }, true);
    expect(result.total).toBe(20);
  });

  it('caps failures at 20 when window is full', () => {
    const result = updateDispatchOutcome({ failures: 18, total: 20 }, false);
    expect(result).toEqual({ failures: 19, total: 20 });
  });
});
