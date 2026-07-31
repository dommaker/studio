// agentStatus 纯函数单测（§5.2 状态推导：instance.status + 当前 WU.status → 卡片状态）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveAgentStatus, formatUptime, formatRelativeTime } from '../agentStatus';

describe('deriveAgentStatus', () => {
  it('无 instance → none（未启动）', () => {
    expect(deriveAgentStatus(null)).toBe('none');
    expect(deriveAgentStatus(undefined)).toBe('none');
  });

  it('active 按当前 WU.status 细分', () => {
    expect(deriveAgentStatus('active', 'active')).toBe('running');
    expect(deriveAgentStatus('active', 'in_review')).toBe('in_review');
    expect(deriveAgentStatus('active', 'blocked')).toBe('blocked');
  });

  it('active + 其他/缺失 WU.status → running', () => {
    expect(deriveAgentStatus('active', null)).toBe('running');
    expect(deriveAgentStatus('active', undefined)).toBe('running');
    expect(deriveAgentStatus('active', 'unassigned')).toBe('running');
  });

  it('idle / error / terminated 直通', () => {
    expect(deriveAgentStatus('idle')).toBe('idle');
    expect(deriveAgentStatus('error')).toBe('error');
    expect(deriveAgentStatus('terminated')).toBe('terminated');
  });

  it('未知 instance.status → none 兜底', () => {
    expect(deriveAgentStatus('whatever')).toBe('none');
  });
});

describe('formatUptime', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('分钟/小时/天档位', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'));
    expect(formatUptime('2026-07-31T11:55:00Z')).toBe('5m');
    expect(formatUptime('2026-07-31T09:30:00Z')).toBe('2h 30m');
    expect(formatUptime('2026-07-30T08:00:00Z')).toBe('1d 4h');
  });
});

describe('formatRelativeTime', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('秒/分/时/天档位', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'));
    expect(formatRelativeTime('2026-07-31T11:59:30Z')).toBe('30s前');
    expect(formatRelativeTime('2026-07-31T11:55:00Z')).toBe('5m前');
    expect(formatRelativeTime('2026-07-31T09:00:00Z')).toBe('3h前');
    expect(formatRelativeTime('2026-07-29T12:00:00Z')).toBe('2d前');
  });

  it('非法时间 → 空串（不编造）', () => {
    expect(formatRelativeTime('not-a-date')).toBe('');
  });
});
