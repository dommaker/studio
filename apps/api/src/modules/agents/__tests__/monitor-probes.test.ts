/**
 * monitor-probes — 任务/WorkUnit 级探测
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpDir, mockLogger, mockAgentStop, mockReaddir, mockGetStats } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-probes-')),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockAgentStop: vi.fn(() => Promise.resolve()),
    mockReaddir: vi.fn(() => Promise.resolve([] as any[])),
    mockGetStats: vi.fn(() => ({} as Record<string, any>)),
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
  resolveEventsDir: () => tmpDir,
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stop: mockAgentStop, execute: vi.fn() },
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({ knowledgeService: {} }));
vi.mock('../triage-agent.service.js', () => ({ triageAgent: { handleAlert: vi.fn(() => Promise.resolve()) } }));

vi.mock('../../mcp/tool-registry.js', () => ({
  toolRegistry: { getStats: mockGetStats },
}));

import {
  checkFailureTrend,
  checkProgressStagnation,
  checkTotalExecutionTime,
  checkHeartbeatLoss,
  autoAbandonStaleBlocked,
  autoAbandonStaleRunning,
  checkSessionFileHealth,
  checkReviewQuality,
  checkTokenBudget,
  checkDeployPushFailed,
  checkProxyRestartExhausted,
  checkToolPatterns,
} from '../monitor-probes.js';

function makeFileStore(overrides: Record<string, unknown> = {}): any {
  return {
    getIndex: vi.fn(async () => []),
    readJson: vi.fn(async () => null),
    readJsonl: vi.fn(async () => []),
    upsertSnapshot: vi.fn(async () => {}),
    removeSnapshot: vi.fn(async () => {}),
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
  it('auto-fails workUnit exceeding 2.5h: critical alert + agentRunner.stop + close snapshot', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const exec = makeSnapshot({ id: 'exec-timeout', status: 'active', claimedAt: threeHoursAgo, createdAt: threeHoursAgo });
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [exec]) });

    const alerts = await checkTotalExecutionTime(fileStore);

    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'total_time', level: 'critical', relatedTaskIds: ['exec-timeout'] }),
    ]));
    expect(mockAgentStop).toHaveBeenCalledWith('exec-timeout');
    expect(fileStore.upsertSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exec-timeout', status: 'closed', completedAt: expect.any(String) }),
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
    expect(fileStore.upsertSnapshot).not.toHaveBeenCalled();
  });
});

describe('autoAbandon probes', () => {
  it('checkHeartbeatLoss is a no-op returning []', async () => {
    expect(await checkHeartbeatLoss()).toEqual([]);
  });

  it('autoAbandonStaleBlocked closes blocked workUnits older than 24h', async () => {
    const stale = makeSnapshot({ id: 'wu-stale', status: 'blocked', createdAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
    const fresh = makeSnapshot({ id: 'wu-fresh', status: 'blocked', createdAt: new Date().toISOString() });
    const fileStore = makeFileStore({
      getIndex: vi.fn(async (filter?: any) => (filter?.status === 'blocked' ? [stale, fresh] : [stale, fresh])),
    });

    await autoAbandonStaleBlocked(fileStore);

    expect(fileStore.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(fileStore.upsertSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'wu-stale', status: 'closed' }));
  });

  it('autoAbandonStaleRunning is a no-op (covered by workunit-timeout trigger)', async () => {
    const fileStore = makeFileStore();
    await autoAbandonStaleRunning();
    expect(fileStore.getIndex).not.toHaveBeenCalled();
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

describe('checkReviewQuality', () => {
  const mkDone = (id: string, metadata: any) => makeSnapshot({
    id, status: 'done', metadata: JSON.stringify(metadata), updatedAt: new Date().toISOString(),
  });

  it('reviewScore=0 (never scored) produces no alert', async () => {
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkDone('wu-0', { reviewScore: 0 })]) });
    expect(await checkReviewQuality(fileStore)).toEqual([]);
  });

  it('reviewScore < 50 produces critical alert; 50-74 warning', async () => {
    let fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkDone('wu-low', { reviewScore: 40, reviewCycle: 2 })]) });
    let alerts = await checkReviewQuality(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'review_quality', level: 'critical' });
    expect(alerts[0].message).toContain('after 2 cycles');

    fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkDone('wu-mid', { reviewScore: 60 })]) });
    alerts = await checkReviewQuality(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].message).toContain('(first cycle)');
  });
});

describe('checkTokenBudget', () => {
  const mkWu = (id: string, tokens: number) => makeSnapshot({
    id, status: 'done', metadata: JSON.stringify({ _cumulativeTokens: tokens }), updatedAt: new Date().toISOString(),
  });

  it('critical ≥ 1M tokens, warning ≥ 500K, none below', async () => {
    const fileStore = makeFileStore({
      getIndex: vi.fn(async () => [mkWu('wu-crit', 1_200_000), mkWu('wu-warn', 600_000), mkWu('wu-ok', 100_000)]),
    });

    const alerts = await checkTokenBudget(fileStore);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ level: 'critical', source: 'total_time' });
    expect(alerts[0].message).toContain('1200K');
    expect(alerts[1]).toMatchObject({ level: 'warning', source: 'total_time' });
    expect(alerts[1].message).toContain('600K');
  });
});

describe('deploy / proxy event probes', () => {
  it('checkDeployPushFailed emits critical alert for recent deploy_push_failed events', async () => {
    const events = [
      { type: 'deploy_push_failed', timestamp: new Date().toISOString(), payload: JSON.stringify({ error: 'permission denied', branch: 'main' }) },
      { type: 'deploy_push_failed', timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(), payload: JSON.stringify({ error: 'stale' }) },
      { type: 'other_event', timestamp: new Date().toISOString(), payload: '{}' },
    ];
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => events) });

    const alerts = await checkDeployPushFailed(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'deploy_push_failed', level: 'critical' });
    expect(alerts[0].message).toContain('permission denied');
    expect(alerts[0].message).toContain('main');
  });

  it('checkProxyRestartExhausted emits critical alert for recent proxy_restart_exhausted events', async () => {
    const events = [
      { type: 'proxy_restart_exhausted', timestamp: new Date().toISOString(), payload: JSON.stringify({ restartsThisHour: 5, synSentCount: 42 }) },
    ];
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => events) });

    const alerts = await checkProxyRestartExhausted(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'proxy_restart_exhausted', level: 'critical' });
    expect(alerts[0].message).toContain('5 restarts/h');
  });

  it('returns empty when events file unreadable', async () => {
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => { throw new Error('ENOENT'); }) });
    expect(await checkDeployPushFailed(fileStore)).toEqual([]);
    expect(await checkProxyRestartExhausted(fileStore)).toEqual([]);
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
