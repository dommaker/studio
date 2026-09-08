// agentStatus 纯函数单测（§5.2 状态推导：instance.status + 当前 WU.status → 卡片状态）
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveAgentStatus,
  resolveCardStatusKey,
  resolveDisplayStatus,
  AGENT_STATUS_COLORS,
  CARD_STATUS_COLORS,
  CARD_TO_DISPLAY_STATUS,
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUS_COLORS,
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

describe('resolveDisplayStatus（7+1 细分 → 4 态展示合并）', () => {
  it('running → working', () => {
    expect(resolveDisplayStatus('active', 'active', 'active')).toBe('working');
  });

  it('in_review / blocked / error → attention', () => {
    expect(resolveDisplayStatus('active', 'active', 'in_review')).toBe('attention');
    expect(resolveDisplayStatus('active', 'active', 'blocked')).toBe('attention');
    expect(resolveDisplayStatus('active', 'error', null)).toBe('attention');
  });

  it('idle → idle；none / terminated / disabled → offline', () => {
    expect(resolveDisplayStatus('active', 'idle', null)).toBe('idle');
    expect(resolveDisplayStatus('active', null, null)).toBe('offline');
    expect(resolveDisplayStatus('active', 'terminated', null)).toBe('offline');
    expect(resolveDisplayStatus('disabled', 'active', 'active')).toBe('offline');
  });

  it('映射表覆盖全部 8 个细分键', () => {
    expect(Object.keys(CARD_TO_DISPLAY_STATUS).sort()).toEqual(
      ['blocked', 'disabled', 'error', 'idle', 'in_review', 'none', 'running', 'terminated'].sort(),
    );
  });
});

describe('DISPLAY_STATUS_LABELS / DISPLAY_STATUS_COLORS（4 态展示词与色）', () => {
  it('展示词：工作中 / 待处理 / 空闲 / 离线', () => {
    expect(DISPLAY_STATUS_LABELS).toEqual({
      working: '工作中',
      attention: '待处理',
      idle: '空闲',
      offline: '离线',
    });
  });

  it('展示色：working=绿（u-accent）/ attention=黄（u-warn）/ idle·offline=灰', () => {
    expect(DISPLAY_STATUS_COLORS.working).toContain('u-accent');
    expect(DISPLAY_STATUS_COLORS.attention).toContain('u-warn');
    expect(DISPLAY_STATUS_COLORS.idle).toBe(DISPLAY_STATUS_COLORS.offline);
    expect(DISPLAY_STATUS_COLORS.idle).toContain('u-surface-2');
  });
});

describe('AGENT_STATUS_RANK（4 态注意力排序：待处理→工作中→空闲→离线）', () => {
  it('档位关系', () => {
    expect(AGENT_STATUS_RANK.attention).toBeLessThan(AGENT_STATUS_RANK.working);
    expect(AGENT_STATUS_RANK.working).toBeLessThan(AGENT_STATUS_RANK.idle);
    expect(AGENT_STATUS_RANK.idle).toBeLessThan(AGENT_STATUS_RANK.offline);
  });
});

describe('matchesStatusFilter（4 态口径）', () => {
  it('all 全过；展示键按映射匹配', () => {
    expect(matchesStatusFilter('blocked', 'all')).toBe(true);
    expect(matchesStatusFilter('running', 'working')).toBe(true);
    expect(matchesStatusFilter('running', 'attention')).toBe(false);
    expect(matchesStatusFilter('idle', 'idle')).toBe(true);
    expect(matchesStatusFilter('idle', 'offline')).toBe(false);
  });

  it('attention 聚合 待评审/阻塞/异常', () => {
    expect(matchesStatusFilter('in_review', 'attention')).toBe(true);
    expect(matchesStatusFilter('blocked', 'attention')).toBe(true);
    expect(matchesStatusFilter('error', 'attention')).toBe(true);
    expect(matchesStatusFilter('running', 'attention')).toBe(false);
  });

  it('offline 聚合 未启动/已终止/已停用', () => {
    expect(matchesStatusFilter('none', 'offline')).toBe(true);
    expect(matchesStatusFilter('terminated', 'offline')).toBe(true);
    expect(matchesStatusFilter('disabled', 'offline')).toBe(true);
    expect(matchesStatusFilter('idle', 'offline')).toBe(false);
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

  it('CARD_STATUS_COLORS：继承全部实例色 + disabled 归灰（#433）', () => {
    expect(CARD_STATUS_COLORS.running).toBe(AGENT_STATUS_COLORS.running);
    expect(CARD_STATUS_COLORS.disabled).toBe(AGENT_STATUS_COLORS.idle);
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
