/**
 * monitor-alerts 冷却去重（#220，#218 决议）：
 * 指纹 = source + subject（回退 relatedTaskIds[0] → source 单车道）；
 * 同指纹 warning 4h / critical 1h 内只出声一次；升级立即出声；同级漂移压掉；降级不动作；惰性 GC 24h。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { recordPattern: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../triage/triage.service.js', () => ({
  triageService: { handleAlert: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../../../utils/notifier.js', () => ({
  notifyAlert: vi.fn(() => Promise.resolve()),
}));

import {
  ALERT_COOLDOWN_WARN_MS,
  ALERT_COOLDOWN_CRIT_MS,
  ALERT_COOLDOWN_GC_MS,
} from '@dommaker/studio-shared';
import {
  alertCooldownState,
  alertFingerprint,
  filterCooldownAlerts,
} from '../monitor/monitor-alerts.js';
import type { MonitorAlert } from '../types.js';

const T0 = 1_760_000_000_000;

function makeAlert(partial: Partial<MonitorAlert> & Pick<MonitorAlert, 'source'>): MonitorAlert {
  return { level: 'warning', message: 'm', ...partial };
}

beforeEach(() => {
  alertCooldownState.clear();
  vi.clearAllMocks();
});

describe('alertFingerprint — 回退链', () => {
  it('subject 优先于 relatedTaskIds[0]', () => {
    const fp = alertFingerprint(makeAlert({
      source: 'agent_timeout_scan', subject: 'inst-1', relatedTaskIds: ['wu-1'],
    }));
    expect(fp).toBe('agent_timeout_scan:inst-1');
  });

  it('无 subject 回退 relatedTaskIds[0]', () => {
    const fp = alertFingerprint(makeAlert({ source: 'failure_trend', relatedTaskIds: ['wu-1', 'wu-2'] }));
    expect(fp).toBe('failure_trend:wu-1');
  });

  it('两者皆无 → source 单车道', () => {
    expect(alertFingerprint(makeAlert({ source: 'pool_stagnation' }))).toBe('pool_stagnation:');
  });

  it('同 subject 不同 source 互不吞并', () => {
    const a = alertFingerprint(makeAlert({ source: 'tool_error_rate', subject: 'Bash' }));
    const b = alertFingerprint(makeAlert({ source: 'tool_zero_success', subject: 'Bash' }));
    expect(a).not.toBe(b);
  });
});

describe('filterCooldownAlerts — 冷却压制', () => {
  it('首轮出声，同窗内同指纹压制（含消息内容漂移）', () => {
    const a1 = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-1', message: '过期 5 分钟' });
    expect(filterCooldownAlerts([a1], T0)).toEqual([a1]);
    // 同级内容漂移（分钟数变化）不打破冷却
    const a2 = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-1', message: '过期 10 分钟' });
    expect(filterCooldownAlerts([a2], T0 + 5 * 60_000)).toEqual([]);
    // 压制打 debug 级日志，不进事件流
    expect(mockLogger.debug).toHaveBeenCalledOnce();
  });

  it('warning 冷却窗（4h）过后补发一次', () => {
    const a = makeAlert({ source: 'pool_stagnation' });
    filterCooldownAlerts([a], T0);
    expect(filterCooldownAlerts([a], T0 + ALERT_COOLDOWN_WARN_MS - 1)).toEqual([]);
    expect(filterCooldownAlerts([a], T0 + ALERT_COOLDOWN_WARN_MS)).toEqual([a]);
  });

  it('critical 冷却窗为 1h', () => {
    const a = makeAlert({ source: 'failure_trend', level: 'critical', relatedTaskIds: ['wu-1'] });
    filterCooldownAlerts([a], T0);
    expect(filterCooldownAlerts([a], T0 + ALERT_COOLDOWN_CRIT_MS - 1)).toEqual([]);
    expect(filterCooldownAlerts([a], T0 + ALERT_COOLDOWN_CRIT_MS)).toEqual([a]);
  });

  it('不同 subject 互不吞并（不同实例/工具各自出声）', () => {
    const a = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-1' });
    const b = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-2' });
    expect(filterCooldownAlerts([a, b], T0)).toEqual([a, b]);
    expect(filterCooldownAlerts([a, b], T0 + 60_000)).toEqual([]);
  });

  it('同 subject 时 relatedTaskIds 首位轮换不打破冷却（聚合探针 churn 场景）', () => {
    const a = makeAlert({ source: 'failure_trend', subject: 'global', relatedTaskIds: ['wu-1', 'wu-2'] });
    filterCooldownAlerts([a], T0);
    const rotated = makeAlert({ source: 'failure_trend', subject: 'global', relatedTaskIds: ['wu-9', 'wu-8'] });
    expect(filterCooldownAlerts([rotated], T0 + 5 * 60_000)).toEqual([]);
    // 且同 subject 下 warning → critical 升级正常触发
    const crit = makeAlert({ source: 'failure_trend', level: 'critical', subject: 'global' });
    expect(filterCooldownAlerts([crit], T0 + 6 * 60_000)).toEqual([crit]);
  });
});

describe('filterCooldownAlerts — 级别迁移', () => {
  it('warning → critical 升级无视冷却立即出声并重置计时', () => {
    const warn = makeAlert({ source: 'analysis_respawn', relatedTaskIds: ['wu-1'] });
    filterCooldownAlerts([warn], T0);
    const crit = makeAlert({ source: 'analysis_respawn', level: 'critical', relatedTaskIds: ['wu-1'] });
    expect(filterCooldownAlerts([crit], T0 + 60_000)).toEqual([crit]);
    // 计时已重置：critical 1h 窗内再压
    expect(filterCooldownAlerts([crit], T0 + 60_000 + 30 * 60_000)).toEqual([]);
  });

  it('critical → warning 降级不动作（按 warning 冷却继续压）', () => {
    const crit = makeAlert({ source: 'analysis_respawn', level: 'critical', relatedTaskIds: ['wu-1'] });
    filterCooldownAlerts([crit], T0);
    // 已过 critical 1h 窗但未过 warning 4h 窗 → 降级不立即出声
    const warn = makeAlert({ source: 'analysis_respawn', relatedTaskIds: ['wu-1'] });
    expect(filterCooldownAlerts([warn], T0 + 2 * 60 * 60_000)).toEqual([]);
  });

  it('warning → info 非升级，同窗压制', () => {
    const warn = makeAlert({ source: 'session_file_size', relatedTaskIds: ['wu-1'] });
    filterCooldownAlerts([warn], T0);
    const info = makeAlert({ source: 'session_file_size', level: 'info', relatedTaskIds: ['wu-1'] });
    expect(filterCooldownAlerts([info], T0 + 60_000)).toEqual([]);
  });
});

describe('filterCooldownAlerts — 惰性 GC', () => {
  it('超 24h 未见的条目在下次过滤时删除', () => {
    const a = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-1' });
    filterCooldownAlerts([a], T0);
    expect(alertCooldownState.size).toBe(1);
    // 25h 后另一个指纹触发过滤 → 旧条目 GC
    const b = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-2' });
    filterCooldownAlerts([b], T0 + ALERT_COOLDOWN_GC_MS + 60_000);
    expect(alertCooldownState.has('agent_timeout_scan:inst-1')).toBe(false);
    expect(alertCooldownState.has('agent_timeout_scan:inst-2')).toBe(true);
  });

  it('持续出现的条目不被 GC（lastSeenAt 随每轮刷新）', () => {
    const a = makeAlert({ source: 'agent_timeout_scan', subject: 'inst-1' });
    filterCooldownAlerts([a], T0);
    // 每 5min 出现一次（被压制），25h 后条目仍在
    for (let i = 1; i <= 300; i++) {
      filterCooldownAlerts([a], T0 + i * 5 * 60_000);
    }
    expect(alertCooldownState.has('agent_timeout_scan:inst-1')).toBe(true);
  });
});
