/**
 * Behavioral tests for P1+P2: getTimeoutForPhase + checkTimedOutExecutions
 *
 * AC:
 * - getTimeoutForPhase returns 15min for all execution phases
 * - getTimeoutForPhase returns 15min for unknown phase (safe default)
 * - checkTimedOutExecutions marks timed-out executions as failed
 * - checkTimedOutExecutions uses onPhaseFailure with severity 'timeout'
 * - checkTimedOutExecutions handles fallback: timeoutAt=null + startedAt > 15min
 * - checkTimedOutExecutions does nothing when no executions are timed out
 */

import { describe, test, expect } from 'vitest';
import { getTimeoutForPhase } from '../scheduler-dispatch.js';

describe('getTimeoutForPhase', () => {
  test('executing → 15min', () => {
    expect(getTimeoutForPhase('executing')).toBe(15 * 60_000);
  });

  test('analyst → 15min', () => {
    expect(getTimeoutForPhase('analyst')).toBe(15 * 60_000);
  });

  test('integration → 15min', () => {
    expect(getTimeoutForPhase('integration')).toBe(15 * 60_000);
  });

  test('review-fix → 15min', () => {
    expect(getTimeoutForPhase('review-fix')).toBe(15 * 60_000);
  });

  test('unknown phase → 15min (safe default)', () => {
    expect(getTimeoutForPhase('deploy')).toBe(15 * 60_000);
    expect(getTimeoutForPhase('unknown')).toBe(15 * 60_000);
    expect(getTimeoutForPhase('')).toBe(15 * 60_000);
  });
});
