// Cron Matcher Tests (3.28c-4) — RED phase
import { describe, it, expect } from 'vitest';
import { CronMatcher } from '../cron-matcher';

describe('CronMatcher', () => {
  // cron format: minute hour day-of-month month day-of-week

  it('matches wildcard (every minute)', () => {
    const matcher = new CronMatcher('* * * * *');
    const date = new Date('2026-06-22T09:17:00');
    expect(matcher.matches(date)).toBe(true);
  });

  it('matches exact minute and hour', () => {
    const matcher = new CronMatcher('17 9 * * *');
    expect(matcher.matches(new Date('2026-06-22T09:17:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:18:00'))).toBe(false);
    expect(matcher.matches(new Date('2026-06-22T10:17:00'))).toBe(false);
  });

  it('matches comma-separated values', () => {
    const matcher = new CronMatcher('0,30 * * * *');
    expect(matcher.matches(new Date('2026-06-22T09:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:30:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:15:00'))).toBe(false);
  });

  it('matches range (dash)', () => {
    const matcher = new CronMatcher('0 9-17 * * *');
    expect(matcher.matches(new Date('2026-06-22T09:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T12:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T17:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T18:00:00'))).toBe(false);
    expect(matcher.matches(new Date('2026-06-22T08:00:00'))).toBe(false);
  });

  it('matches step values (slash)', () => {
    const matcher = new CronMatcher('*/15 * * * *');
    expect(matcher.matches(new Date('2026-06-22T09:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:15:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:30:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:45:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-22T09:10:00'))).toBe(false);
  });

  it('matches day of week', () => {
    // 2026-06-22 is Monday (1)
    const matcher = new CronMatcher('0 9 * * 1');
    expect(matcher.matches(new Date('2026-06-22T09:00:00'))).toBe(true); // Mon
    expect(matcher.matches(new Date('2026-06-23T09:00:00'))).toBe(false); // Tue
  });

  it('matches specific day of month', () => {
    const matcher = new CronMatcher('0 0 15 * *');
    expect(matcher.matches(new Date('2026-06-15T00:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-06-16T00:00:00'))).toBe(false);
  });

  it('matches specific month', () => {
    const matcher = new CronMatcher('0 0 1 6 *');
    expect(matcher.matches(new Date('2026-06-01T00:00:00'))).toBe(true);
    expect(matcher.matches(new Date('2026-07-01T00:00:00'))).toBe(false);
  });

  it('validates cron expression', () => {
    expect(CronMatcher.isValid('* * * * *')).toBe(true);
    expect(CronMatcher.isValid('17 9 * * *')).toBe(true);
    expect(CronMatcher.isValid('0,30 9-17 * * 1-5')).toBe(true);
    expect(CronMatcher.isValid('*/15 * * * *')).toBe(true);

    expect(CronMatcher.isValid('')).toBe(false);
    expect(CronMatcher.isValid('* *')).toBe(false);
    expect(CronMatcher.isValid('60 * * * *')).toBe(false); // minute > 59
    expect(CronMatcher.isValid('abc * * * *')).toBe(false);
  });

  it('handles combined expressions', () => {
    // Every 15 min during work hours (9-17), Mon-Fri
    const matcher = new CronMatcher('*/15 9-17 * * 1-5');
    // Mon 09:00 — yes
    expect(matcher.matches(new Date('2026-06-22T09:00:00'))).toBe(true);
    // Mon 09:15 — yes
    expect(matcher.matches(new Date('2026-06-22T09:15:00'))).toBe(true);
    // Mon 08:00 — no (before 9)
    expect(matcher.matches(new Date('2026-06-22T08:00:00'))).toBe(false);
    // Sat 09:00 — no (weekend)
    expect(matcher.matches(new Date('2026-06-27T09:00:00'))).toBe(false);
  });
});
