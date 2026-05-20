/**
 * MonitorAgent 测试 — G4 Trajectory Eval
 */
import { describe, it, expect } from 'vitest';

describe('MonitorAgent — G4 Trajectory Eval', () => {
  // G4: trajectory = structured report from existing progress/retry/time data
  it('efficiency verdict 逻辑：≥60% good, ≥30% degraded, <30% poor', () => {
    const verdict = (efficiency: number) => efficiency >= 60 ? 'good' : efficiency >= 30 ? 'degraded' : 'poor';
    expect(verdict(75)).toBe('good');
    expect(verdict(60)).toBe('good');
    expect(verdict(45)).toBe('degraded');
    expect(verdict(30)).toBe('degraded');
    expect(verdict(15)).toBe('poor');
  });

  it('slowRate 告警阈值：>30% 触发 warning', () => {
    const shouldAlert = (slowRate: number) => slowRate > 30;
    expect(shouldAlert(35)).toBe(true);
    expect(shouldAlert(30)).toBe(false);
    expect(shouldAlert(10)).toBe(false);
  });
});
