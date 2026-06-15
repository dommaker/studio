/**
 * Behavioral tests for conservative mode concurrency wiring
 *
 * AC:
 * - getAvailableSlots() without maxCap returns resource-based value
 * - getAvailableSlots(maxCap) caps result to maxCap
 * - getDispatchStrategy returns 'conservative' when failRate > 0.5 and total >= 5
 * - getDispatchStrategy returns 'normal' when total < 5
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

// Mock os module to control resource readings
vi.mock('os', () => ({
  freemem: vi.fn(),
  totalmem: vi.fn(),
  loadavg: vi.fn(),
  cpus: vi.fn(),
  homedir: vi.fn(() => '/tmp'),
}));

import * as os from 'os';
import { getAvailableSlots, getDispatchStrategy } from '../scheduler-queue.js';

function setupOs({ freePct, loadAvg, cores }: { freePct: number; loadAvg: number; cores: number }) {
  const total = 16 * 1024 * 1024 * 1024; // 16 GB
  (os.freemem as unknown as ReturnType<typeof vi.fn>).mockReturnValue(total * freePct);
  (os.totalmem as unknown as ReturnType<typeof vi.fn>).mockReturnValue(total);
  (os.loadavg as unknown as ReturnType<typeof vi.fn>).mockReturnValue([loadAvg, 0, 0]);
  (os.cpus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    Array.from({ length: cores }, () => ({} as ReturnType<typeof os.cpus>[number])),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: healthy resources → would give 5 slots
  setupOs({ freePct: 0.6, loadAvg: 0.3, cores: 8 });
});

describe('getAvailableSlots()', () => {
  test('without maxCap returns resource-based value (healthy → 5)', () => {
    const slots = getAvailableSlots();
    expect(slots).toBe(5);
  });

  test('without maxCap returns 1 when freeMemPct < 0.15', () => {
    setupOs({ freePct: 0.1, loadAvg: 0.3, cores: 8 });
    expect(getAvailableSlots()).toBe(1);
  });

  test('with maxCap=2 caps result to 2 even when resources allow 5', () => {
    expect(getAvailableSlots(2)).toBe(2);
  });

  test('with maxCap=2 caps low-memory result (1) stays at 1', () => {
    setupOs({ freePct: 0.1, loadAvg: 0.3, cores: 8 });
    // Resource says 1, cap says 2 → min(1, 2) = 1
    expect(getAvailableSlots(2)).toBe(1);
  });

  test('with maxCap=10 does not increase beyond resource value', () => {
    // Resource says 5, cap says 10 → min(5, 10) = 5
    expect(getAvailableSlots(10)).toBe(5);
  });
});

describe('getDispatchStrategy()', () => {
  test('returns conservative when failRate > 0.5 and total >= 5', () => {
    // 4 failures out of 6 → failRate 0.667 > 0.5
    expect(getDispatchStrategy(4, 6)).toBe('conservative');
  });

  test('returns normal when failRate <= 0.5 and total >= 5', () => {
    // 2 failures out of 6 → failRate 0.333
    expect(getDispatchStrategy(2, 6)).toBe('normal');
  });

  test('returns normal when total < 5 (insufficient data)', () => {
    // 3 failures out of 3 → failRate 1.0, but total < 5
    expect(getDispatchStrategy(3, 3)).toBe('normal');
  });

  test('returns normal when total is 0', () => {
    expect(getDispatchStrategy(0, 0)).toBe('normal');
  });

  test('returns conservative at boundary: 3 failures out of 5', () => {
    // failRate = 0.6 > 0.5
    expect(getDispatchStrategy(3, 5)).toBe('conservative');
  });

  test('returns normal at boundary: 2 failures out of 5', () => {
    // failRate = 0.4 <= 0.5
    expect(getDispatchStrategy(2, 5)).toBe('normal');
  });
});
