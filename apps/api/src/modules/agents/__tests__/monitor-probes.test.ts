/**
 * monitor-probes — 任务/WorkUnit 级探测
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpDir, mockLogger, mockAgentStop, mockReaddir, mockGetStats, mockCloseWithNotice } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-probes-')),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockAgentStop: vi.fn(() => Promise.resolve()),
    mockReaddir: vi.fn(() => Promise.resolve([] as any[])),
    mockGetStats: vi.fn(() => ({} as Record<string, any>)),
    // #176（决策 #62 §3 双出声）：关闭统一出口（事件 + 频道 + 快照）打桩，探头只断言委托
    mockCloseWithNotice: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, readdir: mockReaddir },
  };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stop: mockAgentStop, execute: vi.fn() },
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({ knowledgeService: {} }));
vi.mock('../triage/triage.service.js', () => ({ triageService: { handleAlert: vi.fn(() => Promise.resolve()) } }));

vi.mock('../../mcp/tool-registry.js', () => ({
  toolRegistry: { getStats: mockGetStats },
}));

// #176：关闭双出声出口（wu-closure）打桩 —— 其自身行为由 wu-closure.test.ts 覆盖
vi.mock('../../workunit/wu-closure.js', () => ({
  closeWorkUnitWithNotice: mockCloseWithNotice,
  WORKUNIT_CLOSED_EVENT_TYPE: 'workunit:closed',
}));

import {
  checkFailureTrend,
  checkProgressStagnation,
  checkTotalExecutionTime,
  autoAbandonStaleBlocked,
  checkSessionFileHealth,
  checkToolPatterns,
} from '../monitor/monitor-probes.js';

function makeFileStore(overrides: Record<string, unknown> = {}): any {
  return {
    getIndex: vi.fn(async () => []),
    readJson: vi.fn(async () => null),
    readJsonl: vi.fn(async () => []),
    upsertSnapshot: vi.fn(async () => {}),
    removeSnapshot: vi.fn(async () => {}),
    // #170：写路径改走锁内成对原语
    commitSnapshot: vi.fn(async () => {}),
    commitRemoval: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'wu-1', parentId: null, type: 'task', scope: '', assigneeId: null,
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, metadata: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    claimedAt: null, completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddir.mockResolvedValue([] as any);
  mockGetStats.mockReturnValue({}); // clearAllMocks 不清实现，显式重置
});

afterEach(() => {
  delete process.env.SESSION_FILE_PATH;
});

describe('checkFailureTrend', () => {
  it('returns empty when tasks dir unreadable or too few recent tasks', async () => {
    mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
    const alerts = await checkFailureTrend(makeFileStore());
    expect(alerts).toEqual([]);
  });

  it('warns on ≥3 failures and criticals when failure rate >50% with ≥5 tasks', async () => {
    const now = new Date().toISOString();
    const tasks: Record<string, any> = {
      t1: { id: 't1', status: 'failed', startedAt: now, projectId: 'p1' },
      t2: { id: 't2', status: 'failed', startedAt: now, projectId: 'p1' },
      t3: { id: 't3', status: 'failed', startedAt: now, projectId: 'p2' },
      t4: { id: 't4', status: 'failed', startedAt: now, projectId: 'p2' },
      t5: { id: 't5', status: 'completed', startedAt: now, projectId: 'p3' },
    };
    mockReaddir.mockResolvedValue(
      Object.keys(tasks).map(id => ({ name: `${id}.json`, isFile: () => true })) as any,
    );
    const fileStore = makeFileStore({
      readJson: vi.fn(async (p: string) => tasks[path.basename(p, '.json')]),
    });

    const alerts = await checkFailureTrend(fileStore);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ source: 'failure_trend', level: 'warning', projectId: 'p1' });
    expect(alerts[1]).toMatchObject({ source: 'failure_trend', level: 'critical' });
    expect(alerts[1].message).toContain('80%');
  });

  it('ignores tasks older than 1 hour', async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const tasks: Record<string, any> = {
      t1: { id: 't1', status: 'failed', startedAt: old },
      t2: { id: 't2', status: 'failed', startedAt: old },
      t3: { id: 't3', status: 'failed', startedAt: old },
    };
    mockReaddir.mockResolvedValue(
      Object.keys(tasks).map(id => ({ name: `${id}.json`, isFile: () => true })) as any,
    );
    const fileStore = makeFileStore({
      readJson: vi.fn(async (p: string) => tasks[path.basename(p, '.json')]),
    });

    expect(await checkFailureTrend(fileStore)).toEqual([]);
  });
});

describe('checkProgressStagnation', () => {
  it('critical when stagnant > 30min, info when > 15min, none when fresh', async () => {
    const mk = (minAgo: number, id: string) =>
      makeSnapshot({ id, updatedAt: new Date(Date.now() - minAgo * 60_000).toISOString() });

    let fileStore = makeFileStore({ getIndex: vi.fn(async () => [mk(45, 'wu-crit')]) });
    let alerts = await checkProgressStagnation(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'progress_stagnation', level: 'critical' });
    expect(alerts[0].message).toContain('wu-crit');

    fileStore = makeFileStore({ getIndex: vi.fn(async () => [mk(20, 'wu-info')]) });
    alerts = await checkProgressStagnation(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('info');

    fileStore = makeFileStore({ getIndex: vi.fn(async () => [mk(5, 'wu-fresh')]) });
    expect(await checkProgressStagnation(fileStore)).toEqual([]);
  });
});

describe('checkTotalExecutionTime', () => {
  it('auto-fails workUnit exceeding 2.5h: critical alert + agentRunner.stop + 双出声关闭（#176）', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const exec = makeSnapshot({ id: 'exec-timeout', status: 'active', claimedAt: threeHoursAgo, createdAt: threeHoursAgo });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [exec]) });

    const alerts = await checkTotalExecutionTime(fileStore);

    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'total_time', level: 'critical', relatedTaskIds: ['exec-timeout'] }),
    ]));
    expect(mockAgentStop).toHaveBeenCalledWith('exec-timeout');
    // #176（决策 #62 §3）：2.5h 强杀置 closed 补关闭原因事件 + 频道说明（经统一出口）
    expect(mockCloseWithNotice).toHaveBeenCalledTimes(1);
    expect(mockCloseWithNotice).toHaveBeenCalledWith(
      fileStore,
      expect.objectContaining({ id: 'exec-timeout', status: 'active' }),
      expect.objectContaining({ closedBy: 'total-time-kill', reason: expect.stringContaining('2.5h') }),
    );
  });

  it('emits warning at >2h and info at >1h without intervention', async () => {
    const mkActive = (hoursAgo: number) => makeSnapshot({
      id: `exec-${hoursAgo}h`, status: 'active',
      claimedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
      createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkActive(2.2), mkActive(1.2), mkActive(0.5)]) });

    const alerts = await checkTotalExecutionTime(fileStore);
    expect(alerts.map(a => a.level)).toEqual(['warning', 'info']);
    expect(mockAgentStop).not.toHaveBeenCalled();
    expect(mockCloseWithNotice).not.toHaveBeenCalled();
  });
});

describe('autoAbandon probes', () => {
  // #176（决策 #57 D4）：死信计时基准从 createdAt 改 metadata.blockedAt
  it('blockedAt 超 24h → 双出声关闭（即使 createdAt 较新）', async () => {
    const stale = makeSnapshot({
      id: 'wu-stale', status: 'blocked',
      createdAt: new Date(Date.now() - 3600_000).toISOString(), // 创建仅 1h
      metadata: JSON.stringify({ blockedAt: new Date(Date.now() - 25 * 3600_000).toISOString(), blockReason: 'stuck: x' }),
    });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [stale]) });

    await autoAbandonStaleBlocked(fileStore);

    expect(mockCloseWithNotice).toHaveBeenCalledTimes(1);
    expect(mockCloseWithNotice).toHaveBeenCalledWith(
      fileStore,
      expect.objectContaining({ id: 'wu-stale', status: 'blocked' }),
      expect.objectContaining({ closedBy: 'auto-abandon-stale-blocked' }),
    );
  });

  it('createdAt 超 24h 但 blockedAt 新鲜 → 不关闭（修掉「刚 blocked 就被秒关」bug）', async () => {
    const fresh = makeSnapshot({
      id: 'wu-fresh-block', status: 'blocked',
      createdAt: new Date(Date.now() - 72 * 3600_000).toISOString(), // 创建 3 天前
      metadata: JSON.stringify({ blockedAt: new Date(Date.now() - 3600_000).toISOString() }), // 1h 前才 blocked
    });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [fresh]) });

    await autoAbandonStaleBlocked(fileStore);

    expect(mockCloseWithNotice).not.toHaveBeenCalled();
  });

  it('无 blockedAt 的存量 blocked → 回退 createdAt 计时（兼容旧档案）', async () => {
    const legacy = makeSnapshot({
      id: 'wu-legacy', status: 'blocked',
      createdAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
    });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [legacy]) });

    await autoAbandonStaleBlocked(fileStore);

    expect(mockCloseWithNotice).toHaveBeenCalledTimes(1);
  });

  it('decision/spec 类型豁免死信（裁剪状态机无 closed，可等关键人多天）', async () => {
    const decision = makeSnapshot({
      id: 'wu-decision', type: 'decision', status: 'blocked',
      createdAt: new Date(Date.now() - 96 * 3600_000).toISOString(),
      metadata: JSON.stringify({ blockedAt: new Date(Date.now() - 96 * 3600_000).toISOString() }),
    });
    const spec = makeSnapshot({
      id: 'wu-spec', type: 'spec', status: 'blocked',
      createdAt: new Date(Date.now() - 96 * 3600_000).toISOString(),
    });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [decision, spec]) });

    await autoAbandonStaleBlocked(fileStore);

    expect(mockCloseWithNotice).not.toHaveBeenCalled();
  });
});

describe('checkSessionFileHealth', () => {
  it('returns empty when SESSION_FILE_PATH is not set', async () => {
    expect(await checkSessionFileHealth()).toEqual([]);
  });

  it('warns when session file >50MB and >3 days old', async () => {
    const f = path.join(tmpDir, 'session.json');
    fs.writeFileSync(f, '');
    fs.truncateSync(f, 60 * 1024 * 1024); // sparse 60MB
    const oldSec = (Date.now() - 4 * 24 * 3600_000) / 1000;
    fs.utimesSync(f, oldSec, oldSec);
    process.env.SESSION_FILE_PATH = f;

    const alerts = await checkSessionFileHealth();
    expect(alerts).toHaveLength(2);
    expect(alerts.every(a => a.level === 'warning' && a.source === 'session_file_size')).toBe(true);
    expect(alerts[0].message).toContain('60MB');
    expect(alerts[1].message).toContain('4d');
  });

  it('returns empty for a small fresh session file', async () => {
    const f = path.join(tmpDir, 'session-small.json');
    fs.writeFileSync(f, '{}');
    process.env.SESSION_FILE_PATH = f;
    expect(await checkSessionFileHealth()).toEqual([]);
  });
});

describe('checkToolPatterns', () => {
  it('flags error rate >50% (≥5 calls) and zero-success (≥10 calls)', async () => {
    mockGetStats.mockReturnValue({
      flaky: { totalCalls: 10, errorCalls: 6, successCalls: 4 },
      dead: { totalCalls: 12, errorCalls: 12, successCalls: 0 },
      healthy: { totalCalls: 100, errorCalls: 1, successCalls: 99 },
    });

    const alerts = await checkToolPatterns();
    expect(alerts).toHaveLength(3);
    const bySource = alerts.map(a => `${a.source}:${a.message}`);
    expect(bySource.some(s => s.startsWith('tool_error_rate:') && s.includes('flaky'))).toBe(true);
    expect(bySource.some(s => s.startsWith('tool_error_rate:') && s.includes('dead'))).toBe(true);
    expect(bySource.some(s => s.startsWith('tool_zero_success:') && s.includes('dead'))).toBe(true);
    expect(alerts.every(a => a.level === 'warning')).toBe(true);
  });

  it('returns empty when tool registry has no stats', async () => {
    expect(await checkToolPatterns()).toEqual([]);
  });
});
