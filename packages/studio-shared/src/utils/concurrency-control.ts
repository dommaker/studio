/**
 * Concurrency control utilities extracted from Pipeline scheduler.
 *
 * Provides:
 * - Failure-rate based dispatch strategy (conservative/normal)
 * - Resource-aware slot calculation
 * - Sliding window outcome tracking
 */
import * as os from 'os';

/**
 * Determine dispatch strategy based on recent failure rate.
 * @param recentFailures Number of failures in the sliding window
 * @param recentTotal Total dispatches in the sliding window
 * @returns 'conservative' when total >= 5 and failRate > 0.5
 */
export function getDispatchStrategy(
  recentFailures: number,
  recentTotal: number
): 'normal' | 'conservative' {
  if (recentTotal < 5) return 'normal';
  const failRate = recentFailures / recentTotal;
  return failRate > 0.5 ? 'conservative' : 'normal';
}

/**
 * Calculate available concurrency slots based on system resources.
 * @param maxCap Optional upper bound (e.g. 2 for conservative mode)
 * @returns Available slot count: 1/2/5, capped by maxCap
 */
export function getAvailableSlots(maxCap?: number): number {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const freeMemPct = totalMem > 0 ? freeMem / totalMem : 0;
  const load = os.loadavg()[0] / os.cpus().length;

  let slots: number;
  if (freeMemPct < 0.15) slots = 1;
  else if (freeMemPct < 0.30) slots = 2;
  else if (load > 0.90) slots = 2;
  else slots = 5;

  if (maxCap !== undefined) {
    slots = Math.min(slots, maxCap);
  }

  return slots;
}

/**
 * Update the sliding window dispatch outcome counter.
 * @param state Current { failures, total }
 * @param success Whether the current dispatch succeeded
 * @returns Updated { failures, total }, with total capped at 20
 */
export function updateDispatchOutcome(
  state: { failures: number; total: number },
  success: boolean
): { failures: number; total: number } {
  let { failures, total } = state;
  failures += success ? 0 : 1;
  total++;
  if (total > 20) { total = 20; failures = Math.min(failures, 20); }
  return { failures, total };
}
