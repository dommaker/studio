/** #209 smell 3：监控阈值常量正本 + formatAge 相对时间（api 探针与 Web 下钻同源） */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  POOL_STAGNATION_WARN_MS,
  POOL_STAGNATION_CRIT_MS,
  REVIEW_STAGNATION_WARN_MS,
  REVIEW_STAGNATION_CRIT_MS,
  formatAge,
} from '../monitoring';

describe('#181/#167③ 监控阈值常量（#209 smell 3 正本）', () => {
  it('池滞留双阈值：2h warning / 12h critical', () => {
    expect(POOL_STAGNATION_WARN_MS).toBe(2 * 60 * 60 * 1000);
    expect(POOL_STAGNATION_CRIT_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('in_review 滞留双阈值以天计：24h warning / 72h critical', () => {
    expect(REVIEW_STAGNATION_WARN_MS).toBe(24 * 60 * 60 * 1000);
    expect(REVIEW_STAGNATION_CRIT_MS).toBe(72 * 60 * 60 * 1000);
  });
});

describe('formatAge', () => {
  afterEach(() => vi.useRealTimers());

  it('缺时间 -> 时间未知', () => {
    expect(formatAge(undefined)).toBe('时间未知');
  });

  it('无效/未来时间 -> 刚刚', () => {
    expect(formatAge('not-a-date')).toBe('刚刚');
    expect(formatAge(new Date(Date.now() + 60_000).toISOString())).toBe('刚刚');
  });

  it('分钟/小时/天分级', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'));
    const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    expect(formatAge(iso(0.5))).toBe('刚刚');
    expect(formatAge(iso(5))).toBe('5 分钟前');
    expect(formatAge(iso(90))).toBe('1 小时前');
    expect(formatAge(iso(3 * 24 * 60))).toBe('3 天前');
  });
});
