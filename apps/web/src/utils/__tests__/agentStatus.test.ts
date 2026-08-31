// agentStatus 纯函数单测（§5.2 状态推导：instance.status + 当前 WU.status → 卡片状态）
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveAgentStatus,
  resolveCardStatusKey,
  AGENT_STATUS_COLORS,
  AGENT_STATUS_RANK,
  matchesStatusFilter,
  formatUptime,
  formatRelativeTime,
} from '../agentStatus';

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

// #397（redesign §6.2/§6.3/§6.5）：卡面状态统一口径、注意力排序、筛选匹配、状态色单义
describe('resolveCardStatusKey', () => {
  it('profile 非 active → disabled（覆盖 instance 状态）', () => {
    expect(resolveCardStatusKey('inactive', 'active', 'active')).toBe('disabled');
    expect(resolveCardStatusKey('disabled', 'error', null)).toBe('disabled');
  });

  it('profile active → 透传 deriveAgentStatus', () => {
    expect(resolveCardStatusKey('active', 'active', 'blocked')).toBe('blocked');
    expect(resolveCardStatusKey('active', null, null)).toBe('none');
    expect(resolveCardStatusKey('active', 'idle', null)).toBe('idle');
  });
});

describe('AGENT_STATUS_RANK（注意力排序：阻塞/异常→待评审→执行中→空闲→未启动/停用）', () => {
  it('档位关系', () => {
    expect(AGENT_STATUS_RANK.blocked).toBe(AGENT_STATUS_RANK.error);
    expect(AGENT_STATUS_RANK.error).toBeLessThan(AGENT_STATUS_RANK.in_review);
    expect(AGENT_STATUS_RANK.in_review).toBeLessThan(AGENT_STATUS_RANK.running);
    expect(AGENT_STATUS_RANK.running).toBeLessThan(AGENT_STATUS_RANK.idle);
    expect(AGENT_STATUS_RANK.idle).toBeLessThan(AGENT_STATUS_RANK.none);
    expect(AGENT_STATUS_RANK.none).toBe(AGENT_STATUS_RANK.terminated);
    expect(AGENT_STATUS_RANK.terminated).toBe(AGENT_STATUS_RANK.disabled);
  });
});

describe('matchesStatusFilter', () => {
  it('all 全过；同键直通', () => {
    expect(matchesStatusFilter('blocked', 'all')).toBe(true);
    expect(matchesStatusFilter('running', 'running')).toBe(true);
    expect(matchesStatusFilter('running', 'blocked')).toBe(false);
  });

  it('off = 未启动/已终止/已停用 聚合', () => {
    expect(matchesStatusFilter('none', 'off')).toBe(true);
    expect(matchesStatusFilter('terminated', 'off')).toBe(true);
    expect(matchesStatusFilter('disabled', 'off')).toBe(true);
    expect(matchesStatusFilter('idle', 'off')).toBe(false);
  });
});

describe('AGENT_STATUS_COLORS（§6.5 状态色单义）', () => {
  it('异常=橙（u-anomaly），与待评审黄解耦', () => {
    expect(AGENT_STATUS_COLORS.error).toContain('u-anomaly');
    expect(AGENT_STATUS_COLORS.in_review).toContain('u-warn');
    expect(AGENT_STATUS_COLORS.error).not.toBe(AGENT_STATUS_COLORS.in_review);
  });

  it('已终止归灰（红只编码阻塞）', () => {
    expect(AGENT_STATUS_COLORS.terminated).toBe(AGENT_STATUS_COLORS.idle);
    expect(AGENT_STATUS_COLORS.terminated).not.toContain('u-err');
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
