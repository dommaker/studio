/**
 * monitor-probes — 任务/WorkUnit 级探测
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStore } from '@dommaker/studio-shared';

const { tmpDir, mockLogger, mockAgentStop, mockReaddir, mockGetStats, mockCloseWithNotice, mockReadStudioEventsSince } = vi.hoisted(() => {
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
    // #181（决策 #62 D2）：失败趋势改读统一事件流，readStudioEvents 打桩
    mockReadStudioEventsSince: vi.fn(() => Promise.resolve([] as any[])),
  };
});

// 显式清理：hoisted 里的 require('fs') 走原生模块，mkdtemp-cleanup 补丁登记不到
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, readdir: mockReaddir },
  };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
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

// #181：统一事件流读取打桩（全量 mock——真模块顶层 new FileStore() 依赖 shared，不宜 importOriginal）
// #335：读口切到窗口读（studio-events-tail.readStudioEventsSince），打桩随之迁移
vi.mock('../../../utils/studio-events-tail.js', () => ({
  readStudioEventsSince: mockReadStudioEventsSince,
}));
vi.mock('../../../utils/studio-events.js', () => ({
  parseStudioEventPayload: (event: { payload?: unknown }) => {
    const raw = event?.payload;
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  getStudioEventTime: (event: { createdAt?: unknown }) => {
    const ts = typeof event?.createdAt === 'string' ? new Date(event.createdAt).getTime() : NaN;
    return Number.isFinite(ts) ? ts : NaN;
  },
}));

import {
  checkFailureTrend,
  checkPoolStagnation,
  checkReviewStagnation,
  checkStaleClaimGuard,
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
  mockReadStudioEventsSince.mockResolvedValue([] as any);
});

afterEach(() => {
  delete process.env.SESSION_FILE_PATH;
});

// #181（决策 #62 D2）：失败趋势探针改读统一事件流（workunit:failed + execution_step failed）
function makeEvent(type: string, payload: Record<string, unknown>, createdAt = new Date().toISOString()) {
  return { type, source: 'agent-loop', payload: JSON.stringify(payload), createdAt };
}

describe('checkFailureTrend（事件流，#181）', () => {
  it('无近 1h 失败事件 → 无告警，且不再读取 data/tasks 目录', async () => {
    mockReadStudioEventsSince.mockResolvedValue([
      makeEvent('workunit:execution_step', { workUnitId: 'wu-1', status: 'success' }),
    ]);

    expect(await checkFailureTrend(makeFileStore())).toEqual([]);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('≥3 次失败（workunit:failed + 失败步混合计数）→ warning', async () => {
    mockReadStudioEventsSince.mockResolvedValue([
      makeEvent('workunit:failed', { workUnitId: 'wu-a', failureType: 'stuck' }),
      makeEvent('workunit:failed', { workUnitId: 'wu-b', failureType: 'verify' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-c', status: 'failed' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-d', status: 'success' }),
    ]);

    const alerts = await checkFailureTrend(makeFileStore());
    expect(alerts).toHaveLength(1);
    // #220：聚合探针显式 subject 固定车道（relatedTaskIds 首位随 churn 轮换，不作指纹）
    expect(alerts[0]).toMatchObject({ source: 'failure_trend', level: 'warning', subject: 'global' });
    expect(alerts[0].message).toContain('3');
    expect(alerts[0].relatedTaskIds).toEqual(expect.arrayContaining(['wu-a', 'wu-b', 'wu-c']));
  });

  it('失败率 >50% 且样本 ≥5 → warning + critical 双出声', async () => {
    mockReadStudioEventsSince.mockResolvedValue([
      makeEvent('workunit:failed', { workUnitId: 'wu-a' }),
      makeEvent('workunit:failed', { workUnitId: 'wu-b' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-c', status: 'failed' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-d', status: 'failed' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-e', status: 'success' }),
    ]);

    const alerts = await checkFailureTrend(makeFileStore());
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ source: 'failure_trend', level: 'warning', subject: 'global' });
    // #220：warning/critical 同 subject 同车道，升级重置计时逻辑才生效
    expect(alerts[1]).toMatchObject({ source: 'failure_trend', level: 'critical', subject: 'global' });
    expect(alerts[1].message).toContain('80%');
  });

  it('失败 <3 且失败率 ≤50% → 无告警', async () => {
    mockReadStudioEventsSince.mockResolvedValue([
      makeEvent('workunit:execution_step', { workUnitId: 'wu-a', status: 'failed' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-b', status: 'failed' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-c', status: 'success' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-d', status: 'success' }),
      makeEvent('workunit:execution_step', { workUnitId: 'wu-e', status: 'success' }),
    ]);

    expect(await checkFailureTrend(makeFileStore())).toEqual([]);
  });

  it('忽略 1 小时前的事件', async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    mockReadStudioEventsSince.mockResolvedValue([
      makeEvent('workunit:failed', { workUnitId: 'wu-a' }, old),
      makeEvent('workunit:failed', { workUnitId: 'wu-b' }, old),
      makeEvent('workunit:failed', { workUnitId: 'wu-c' }, old),
    ]);

    expect(await checkFailureTrend(makeFileStore())).toEqual([]);
  });
});

// #181（决策 #62 D2）：池滞留探针 —— unassigned 最老 >2h warning / >12h critical，指名未认领区分出声
describe('checkPoolStagnation（#181）', () => {
  const mkUnassigned = (hoursAgo: number, id: string, assigneeId: string | null = null) =>
    makeSnapshot({
      id, status: 'unassigned', assigneeId,
      createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    });

  it('无人认领池最老 >2h → warning，>12h → critical', async () => {
    let fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkUnassigned(3, 'wu-warn'), mkUnassigned(0.5, 'wu-fresh')]) });
    let alerts = await checkPoolStagnation(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'pool_stagnation', level: 'warning', relatedTaskIds: ['wu-warn'], subject: '无人认领' });
    expect(alerts[0].message).toContain('无人认领');

    fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkUnassigned(13, 'wu-crit')]) });
    alerts = await checkPoolStagnation(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'pool_stagnation', level: 'critical' });
  });

  it('指名未认领（assigneeId=profile id）单独区分出声，与池滞留分开告警', async () => {
    const fileStore = makeFileStore({
      getIndex: vi.fn(async () => [
        mkUnassigned(3, 'wu-pool'),
        mkUnassigned(14, 'wu-designated', 'profile-analyst'),
      ]),
    });

    const alerts = await checkPoolStagnation(fileStore);
    expect(alerts).toHaveLength(2);
    const pool = alerts.find(a => a.relatedTaskIds?.includes('wu-pool'));
    const designated = alerts.find(a => a.relatedTaskIds?.includes('wu-designated'));
    expect(pool).toMatchObject({ level: 'warning', subject: '无人认领' });
    expect(pool!.message).toContain('无人认领');
    expect(designated).toMatchObject({ level: 'critical', subject: '指名未认领' });
    expect(designated!.message).toContain('指名未认领');
    expect(designated!.message).toContain('profile-analyst');
  });

  it('全部新鲜（<2h）→ 无告警', async () => {
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkUnassigned(1, 'wu-fresh'), mkUnassigned(0.5, 'wu-fresh2', 'profile-x')]) });
    expect(await checkPoolStagnation(fileStore)).toEqual([]);
  });
});

// #181（决策 #167③）：in_review 滞留探针 —— >24h warning / >72h critical
describe('checkReviewStagnation（#181）', () => {
  const mkInReview = (hoursAgo: number, id: string) =>
    makeSnapshot({
      id, status: 'in_review',
      createdAt: new Date(Date.now() - (hoursAgo + 5) * 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    });

  it('最老 >24h → warning，>72h → critical', async () => {
    let fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkInReview(25, 'wu-warn'), mkInReview(1, 'wu-fresh')]) });
    let alerts = await checkReviewStagnation(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'review_stagnation', level: 'warning', relatedTaskIds: ['wu-warn'], subject: 'global' });

    fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkInReview(73, 'wu-crit')]) });
    alerts = await checkReviewStagnation(fileStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'review_stagnation', level: 'critical' });
  });

  it('全部新鲜（<24h）→ 无告警', async () => {
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [mkInReview(2, 'wu-fresh')]) });
    expect(await checkReviewStagnation(fileStore)).toEqual([]);
  });
});

// #221（#214 决议）：认领陈旧守卫探针 —— unassigned 且 updatedAt >72h（observe 已拦截）首次拦截
// 发 1 条 warning；metadata.staleGuardBlockedAt 落盘防重；标记写 touchUpdatedAt:false 不复活僵尸；
// 外部写刷新 updatedAt 复活，再次沉睡超阈值重新告警。真 FileStore（tmpdir）测外部行为。
describe('checkStaleClaimGuard（#221）', () => {
  const STALE_MS = 72 * 3600_000 + 60_000;
  let guardDir: string;
  let realStore: FileStore;

  beforeEach(() => {
    guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-claim-guard-'));
    realStore = new FileStore(guardDir);
  });

  afterEach(() => {
    fs.rmSync(guardDir, { recursive: true, force: true });
  });

  async function seedStale(id: string, staleMs = STALE_MS, assigneeId: string | null = null): Promise<string> {
    const updatedAt = new Date(Date.now() - staleMs).toISOString();
    await realStore.upsertSnapshot(makeSnapshot({
      id, status: 'unassigned', assigneeId, updatedAt, createdAt: updatedAt,
    }) as never);
    return updatedAt;
  }

  it('陈旧 unassigned → 1 条 warning（指纹含 wuId），标记落盘且 updatedAt/状态不动', async () => {
    const staleIso = await seedStale('wu-stale');

    const alerts = await checkStaleClaimGuard(realStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: 'stale_claim_guard', level: 'warning',
      subject: 'wu-stale', relatedTaskIds: ['wu-stale'],
    });
    expect(alerts[0].message).toContain('回复');
    expect(alerts[0].message).toContain('关闭');

    const [snap] = await realStore.getIndex();
    expect(JSON.parse(snap.metadata!).staleGuardBlockedAt).toBe(staleIso);
    expect(snap.updatedAt).toBe(staleIso); // 守卫自身的标记写不能复活僵尸
    expect(snap.status).toBe('unassigned');
  });

  it('同 WU 跨轮不重复出声（staleGuardBlockedAt === updatedAt 即跳过）', async () => {
    await seedStale('wu-stale');
    expect(await checkStaleClaimGuard(realStore)).toHaveLength(1);
    expect(await checkStaleClaimGuard(realStore)).toEqual([]);
    expect(await checkStaleClaimGuard(realStore)).toEqual([]);
  });

  it('updatedAt 刷新后复活（不再告警）；再次沉睡超阈值重新告警', async () => {
    const firstStale = await seedStale('wu-stale');
    expect(await checkStaleClaimGuard(realStore)).toHaveLength(1);

    // 外部写刷新 updatedAt → 复活，不再告警
    const snap = (await realStore.getIndex())[0];
    await realStore.upsertSnapshot({ ...snap, updatedAt: new Date().toISOString() });
    expect(await checkStaleClaimGuard(realStore)).toEqual([]);

    // 再次沉睡超阈值（updatedAt 与落盘标记不一致）→ 重新告警
    const secondStale = new Date(Date.now() - STALE_MS).toISOString();
    expect(secondStale).not.toBe(firstStale);
    await realStore.upsertSnapshot({ ...snap, updatedAt: secondStale });
    const alerts = await checkStaleClaimGuard(realStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('wu-stale');
  });

  it('72h 内的 unassigned 与非 unassigned 状态不出警', async () => {
    await seedStale('wu-fresh', 2 * 3600_000);
    await realStore.upsertSnapshot(makeSnapshot({
      id: 'wu-active', status: 'active',
      updatedAt: new Date(Date.now() - STALE_MS).toISOString(),
    }) as never);
    expect(await checkStaleClaimGuard(realStore)).toEqual([]);
  });

  it('已标记 WU 不占周期名额：20 条已出声 + 1 条新沉睡 → 新沉睡正常告警（slice 顺序回归）', async () => {
    // 20 条陈旧且已落标记（长期占据 index 前部）
    for (let i = 0; i < 20; i++) {
      const updatedAt = await seedStale(`wu-old-${i}`);
      const snap = (await realStore.getIndex()).find(s => s.id === `wu-old-${i}`)!;
      await realStore.upsertSnapshot({
        ...snap,
        metadata: JSON.stringify({ staleGuardBlockedAt: updatedAt }),
      });
    }
    await seedStale('wu-new');

    const alerts = await checkStaleClaimGuard(realStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('wu-new');
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
