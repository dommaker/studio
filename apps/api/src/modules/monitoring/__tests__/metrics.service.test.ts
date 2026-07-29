/**
 * D16 指标聚合 — aggregateOverview 纯函数 + MetricsService（缓存/文件注入/窗口）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkUnitSnapshot, WorkUnitEvent } from '@dommaker/studio-shared';
import { aggregateOverview, MetricsService } from '../metrics.service.js';

const T = new Date('2026-07-27T12:00:00.000Z').getTime();
const H = 3600_000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();

function makeWu(overrides: Partial<WorkUnitSnapshot> & { metadataObj?: Record<string, unknown> }): WorkUnitSnapshot {
  const { metadataObj, ...rest } = overrides;
  return {
    id: 'wu-x', parentId: null, type: 'feature', scope: 's', assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null,
    metadata: metadataObj ? JSON.stringify(metadataObj) : null,
    createdAt: iso(T - 5 * D), updatedAt: iso(T - 1 * D),
    claimedAt: null, completedAt: null,
    ...rest,
  };
}

function makeInput() {
  const snapshots: WorkUnitSnapshot[] = [
    makeWu({
      id: 'wu-a', status: 'done', assigneeId: 'inst-1',
      createdAt: iso(T - 5 * D), claimedAt: iso(T - 4.5 * D), completedAt: iso(T - 1 * D), updatedAt: iso(T - 1 * D),
      metadataObj: {
        stepCount: 4, _consecutiveReviewRejections: 1,
        verifyReport: { commands: ['make check'], source: 'convention', passedAt: iso(T - 1 * D) },
        mergedAt: iso(T - 1 * D),
      },
    }),
    makeWu({
      id: 'wu-b', status: 'done', assigneeId: 'inst-2',
      createdAt: iso(T - 6 * D), claimedAt: iso(T - 6 * D), completedAt: iso(T - 2 * D), updatedAt: iso(T - 2 * D),
      metadataObj: { stepCount: 2, mergeConflict: true },
    }),
    makeWu({
      id: 'wu-c', status: 'active', assigneeId: 'inst-1',
      createdAt: iso(T - 3 * D), claimedAt: iso(T - 3 * D), updatedAt: iso(T - 1 * D),
      metadataObj: { stepCount: 3, consecutiveStuck: 2, errorType: 'timeout', verifyFailCount: 2 },
    }),
    makeWu({
      id: 'wu-d', status: 'blocked', failureType: 'execution_failed',
      createdAt: iso(T - 2 * D), updatedAt: iso(T - 0.5 * D),
      metadataObj: { waitingForInput: true, waitingReason: 'ownership' },
    }),
    makeWu({
      id: 'wu-e', status: 'unassigned',
      createdAt: iso(T - 10 * D), updatedAt: iso(T - 10 * D),
    }),
  ];

  const wuEvents: WorkUnitEvent[] = [
    { type: 'created', wuId: 'wu-a', timestamp: iso(T - 5 * D) },
    { type: 'created', wuId: 'wu-b', timestamp: iso(T - 6 * D) },
    { type: 'created', wuId: 'wu-c', timestamp: iso(T - 3 * D) },
    { type: 'created', wuId: 'wu-d', timestamp: iso(T - 2 * D) },
    { type: 'created', wuId: 'wu-e', timestamp: iso(T - 10 * D) }, // 窗口外
    { type: 'claimed', wuId: 'wu-a', timestamp: iso(T - 4.5 * D), data: { assigneeId: 'inst-1' } },
    { type: 'claimed', wuId: 'wu-b', timestamp: iso(T - 6 * D), data: { assigneeId: 'inst-2' } },
    { type: 'claimed', wuId: 'wu-c', timestamp: iso(T - 3 * D), data: { assigneeId: 'inst-1' } },
    // NEED_INPUT 挂起：wu-d 澄清期（ownership）；wu-a 执行期（无 waitingReason）
    { type: 'blocked', wuId: 'wu-d', timestamp: iso(T - 0.5 * D), data: { metadata: JSON.stringify({ waitingForInput: true, waitingReason: 'ownership' }) } },
    { type: 'blocked', wuId: 'wu-a', timestamp: iso(T - 4 * D), data: { metadata: JSON.stringify({ waitingForInput: true }) } },
  ];

  const events: Array<Record<string, unknown>> = [
    {
      type: 'workunit:tokens', source: 'agent-loop',
      payload: JSON.stringify({
        workUnitId: 'wu-a', injectedTokens: 100, executionTokens: 900, totalTokens: 1000,
        inputTokens: 400, cacheReadTokens: 300, cacheCreationTokens: 100,
      }),
      createdAt: iso(T - 1 * D),
    },
    {
      type: 'workunit:tokens', source: 'agent-loop',
      payload: JSON.stringify({ workUnitId: 'wu-b', injectedTokens: 200, executionTokens: 800, totalTokens: 1000 }),
      createdAt: iso(T - 2 * D),
    },
    { type: 'monitor:alert', source: 'monitor', payload: JSON.stringify({ level: 'warning', message: 'w' }), createdAt: iso(T - 1 * H) },
    { type: 'monitor:alert', source: 'monitor', payload: JSON.stringify({ level: 'critical', message: 'c' }), createdAt: iso(T - 2 * D) },
  ];

  const humanMessages = [
    { createdAt: iso(T - 1 * D) }, { createdAt: iso(T - 1 * D) }, { createdAt: iso(T - 1 * D) },
    { createdAt: iso(T - 10 * D) }, // 窗口外
  ];

  const instanceToProfile = new Map([['inst-1', 'dev'], ['inst-2', 'reviewer']]);
  const profileNames = new Map([['dev', '开发'], ['reviewer', '评审']]);

  return { snapshots, wuEvents, events, humanMessages, instanceToProfile, profileNames, now: T, windowDays: 7 };
}

describe('aggregateOverview (D16)', () => {
  it('任务流健康：byStatus / 滞留 P50/P95 / 创建→认领 / 认领→完成 / errorType 分桶 / step 统计', () => {
    const m = aggregateOverview(makeInput());

    expect(m.taskFlow.byStatus).toEqual({ done: 2, active: 1, blocked: 1, unassigned: 1 });
    // 滞留：wu-c 24h、wu-d 12h、wu-e 240h → P50=24, P95=240
    expect(m.taskFlow.dwell.count).toBe(3);
    expect(m.taskFlow.dwell.p50Hours).toBe(24);
    expect(m.taskFlow.dwell.p95Hours).toBe(240);
    // 创建→认领：wu-a 12h、wu-b 0h、wu-c 0h（wu-e 窗口外、wu-d 未认领）
    expect(m.taskFlow.createToClaim.count).toBe(3);
    expect(m.taskFlow.createToClaim.p50Hours).toBe(0);
    expect(m.taskFlow.createToClaim.p95Hours).toBe(12);
    // 认领→完成：wu-a 84h、wu-b 96h
    expect(m.taskFlow.claimToComplete.count).toBe(2);
    expect(m.taskFlow.claimToComplete.p50Hours).toBe(96);
    // errorType 分桶：failureType 列优先，其次 metadata.errorType
    expect(m.taskFlow.failuresByErrorType.buckets).toEqual({ execution_failed: 1, timeout: 1 });
    // step 统计：4/2/3 → avg 3；stuck：wu-c consecutiveStuck=2
    expect(m.taskFlow.steps.count).toBe(3);
    expect(m.taskFlow.steps.avgStepCount).toBe(3);
    expect(m.taskFlow.steps.stuckWorkUnits).toBe(1);
    expect(m.taskFlow.steps.avgStuckSteps).toBe(2);
    expect(m.taskFlow.description).toBeTruthy();
  });

  it('入口转化：人类消息 vs 建 WU 数与转化率', () => {
    const m = aggregateOverview(makeInput());
    expect(m.intake.humanMessages).toBe(3);
    expect(m.intake.workUnitsCreated).toBe(4);
    expect(m.intake.conversionPct).toBe(133);
  });

  it('人工干预（北极星）：NEED_INPUT + review 驳回 + 冲突，每完成 WU 均值', () => {
    const m = aggregateOverview(makeInput());
    expect(m.humanIntervention.completedWorkUnits).toBe(2);
    expect(m.humanIntervention.needInputCount).toBe(2);       // wu-d + wu-a
    expect(m.humanIntervention.reviewRejections).toBe(1);     // wu-a._consecutiveReviewRejections
    expect(m.humanIntervention.mergeConflicts).toBe(1);       // wu-b
    expect(m.humanIntervention.avgPerCompletedWu).toBe(2);    // (2+1+1)/2
  });

  it('端到端周期：创建→done P50/P95/avg', () => {
    const m = aggregateOverview(makeInput());
    expect(m.cycleTime.createToDone.count).toBe(2);
    expect(m.cycleTime.createToDone.p50Hours).toBe(96);
    expect(m.cycleTime.avgHours).toBe(96);
  });

  it('角色维度：认领/完成/时长/澄清期 vs 执行期 NEED_INPUT', () => {
    const m = aggregateOverview(makeInput());
    const dev = m.roles.roles.find(r => r.profileId === 'dev')!;
    const reviewer = m.roles.roles.find(r => r.profileId === 'reviewer')!;

    expect(dev.profileName).toBe('开发');
    expect(dev.claims).toBe(2);            // wu-a + wu-c
    expect(dev.completions).toBe(1);       // wu-a
    expect(dev.avgDurationHours).toBe(84); // claimed→completed wu-a
    expect(dev.needInputExecution).toBe(1);
    expect(dev.needInputClarify).toBe(0);

    expect(reviewer.claims).toBe(1);
    expect(reviewer.completions).toBe(1);  // wu-b
    expect(reviewer.avgDurationHours).toBe(96);
    // wu-d 澄清期挂起但无 assignee → 不归因任何角色（不编造归属）
    expect(m.roles.roles.every(r => r.needInputClarify === 0)).toBe(true);
  });

  it('工程质量：verifyReport 通过率 / mergeConflict / mergedAt', () => {
    const m = aggregateOverview(makeInput());
    expect(m.quality.verifyPassed).toBe(1);  // wu-a
    expect(m.quality.verifyFailing).toBe(1); // wu-c
    expect(m.quality.verifyPassRatePct).toBe(50);
    expect(m.quality.mergeConflicts).toBe(1);
    expect(m.quality.merges).toBe(1);        // wu-a mergedAt 在窗口内
  });

  it('Token：合计 / 每 WU 均值 / 缓存命中率与覆盖率 / 按角色聚合', () => {
    const m = aggregateOverview(makeInput());
    expect(m.tokens.totals).toEqual({ injectedTokens: 300, executionTokens: 1700, totalTokens: 2000 });
    expect(m.tokens.workUnits).toBe(2);
    expect(m.tokens.avgTokensPerWu).toBe(850);
    // 缓存：300 / (300+100+400) = 37.5 → 38%；只有 1/2 事件带缓存字段
    expect(m.tokens.cacheHitRatePct).toBe(38);
    expect(m.tokens.cacheCoveragePct).toBe(50);

    const dev = m.tokens.byRole.find(r => r.profileId === 'dev')!;
    expect(dev).toMatchObject({ profileName: '开发', injectedTokens: 100, executionTokens: 900, workUnits: 1 });
    const reviewer = m.tokens.byRole.find(r => r.profileId === 'reviewer')!;
    expect(reviewer).toMatchObject({ injectedTokens: 200, executionTokens: 800, workUnits: 1 });
  });

  it('告警：近 24h / 窗口内 / 按级别', () => {
    const m = aggregateOverview(makeInput());
    expect(m.alerts.last24h).toBe(1);    // T-1h 的 warning
    expect(m.alerts.inWindow).toBe(2);
    expect(m.alerts.byLevel).toEqual({ warning: 1, critical: 1 });
  });

  it('全空输入 → source=insufficient-data，比率型指标 null（不编造）', () => {
    const m = aggregateOverview({
      snapshots: [], wuEvents: [], events: [], humanMessages: [],
      instanceToProfile: new Map(), profileNames: new Map(), now: T, windowDays: 7,
    });
    expect(m.source).toBe('insufficient-data');
    expect(m.intake.conversionPct).toBeNull();
    expect(m.humanIntervention.avgPerCompletedWu).toBeNull();
    expect(m.cycleTime.createToDone.p50Hours).toBeNull();
    expect(m.quality.verifyPassRatePct).toBeNull();
    expect(m.tokens.cacheHitRatePct).toBeNull();
    expect(m.alerts.last24h).toBe(0);
  });

  it('窗口外事件不计入（windowDays=1 时 7 天前数据全部排除）', () => {
    const input = makeInput();
    input.windowDays = 1;
    const m = aggregateOverview(input);
    // 窗口 = T-1d ~ T：只有 wu-a completed (T-1d 边界) 与 T-1h 告警等
    expect(m.tokens.totals.executionTokens).toBe(900); // wu-b T-2d 被排除
    expect(m.alerts.inWindow).toBe(1);                 // 只剩 T-1h
  });

  it('每个指标组都带 description（大白话）', () => {
    const m = aggregateOverview(makeInput());
    for (const group of [m.taskFlow, m.intake, m.humanIntervention, m.cycleTime, m.roles, m.quality, m.tokens, m.alerts]) {
      expect(typeof group.description).toBe('string');
      expect(group.description.length).toBeGreaterThan(10);
    }
  });
});

// ─── MetricsService：文件注入 + 60s 缓存 ───

describe('MetricsService', () => {
  let dir: string;
  let eventsFile: string;
  let wuEventsFile: string;

  const input = makeInput();

  const fileStoreStub = {
    getIndex: vi.fn(async () => input.snapshots),
    readJsonl: vi.fn(async (fp: string) => {
      const real = await import('node:fs/promises');
      try {
        return (await real.readFile(fp, 'utf-8')).split('\n').filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      } catch { return []; }
    }),
    queryAllMessages: vi.fn(async () => input.humanMessages),
    listStates: vi.fn(async () => [{ id: 'inst-1', roleId: 'dev' }, { id: 'inst-2', roleId: 'reviewer' }]),
    listProfiles: vi.fn(async () => [{ id: 'dev', name: '开发' }, { id: 'reviewer', name: '评审' }]),
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-service-'));
    eventsFile = path.join(dir, 'studio-events.jsonl');
    wuEventsFile = path.join(dir, 'wu-events.jsonl');
    fs.writeFileSync(eventsFile, input.events.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(wuEventsFile, input.wuEvents.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('从文件聚合出与纯函数一致的结果', async () => {
    const svc = new MetricsService(fileStoreStub as never);
    const m = await svc.getOverviewMetrics({ eventsFile, wuEventsFile, now: T });
    expect(m.source).toBe('events');
    expect(m.tokens.totals.executionTokens).toBe(1700);
    expect(m.humanIntervention.avgPerCompletedWu).toBe(2);
    expect(m.roles.roles.find(r => r.profileId === 'dev')?.profileName).toBe('开发');
  });

  it('60s 缓存：窗口内第二次调用不重新扫文件；invalidateCache 后重扫', async () => {
    const svc = new MetricsService(fileStoreStub as never);
    const first = await svc.getOverviewMetrics({ eventsFile, wuEventsFile });
    expect(fileStoreStub.getIndex).toHaveBeenCalledTimes(1);

    const second = await svc.getOverviewMetrics({ eventsFile, wuEventsFile });
    expect(second).toBe(first); // 缓存命中返回同一对象
    expect(fileStoreStub.getIndex).toHaveBeenCalledTimes(1);

    svc.invalidateCache();
    await svc.getOverviewMetrics({ eventsFile, wuEventsFile });
    expect(fileStoreStub.getIndex).toHaveBeenCalledTimes(2);
  });

  it('不同 windowDays 走不同缓存键', async () => {
    const svc = new MetricsService(fileStoreStub as never);
    await svc.getOverviewMetrics({ eventsFile, wuEventsFile, windowDays: 7 });
    await svc.getOverviewMetrics({ eventsFile, wuEventsFile, windowDays: 30 });
    expect(fileStoreStub.getIndex).toHaveBeenCalledTimes(2);

    await svc.getOverviewMetrics({ eventsFile, wuEventsFile, windowDays: 7 });
    expect(fileStoreStub.getIndex).toHaveBeenCalledTimes(2); // 7d 命中缓存
  });

  it('注入 now 时跳过缓存（测试/排障口径）', async () => {
    const svc = new MetricsService(fileStoreStub as never);
    await svc.getOverviewMetrics({ eventsFile, wuEventsFile, now: T });
    await svc.getOverviewMetrics({ eventsFile, wuEventsFile, now: T });
    expect(fileStoreStub.getIndex).toHaveBeenCalledTimes(2);
  });

  it('依赖全失败 → 空数据 insufficient-data，绝不抛出', async () => {
    const svc = new MetricsService({
      getIndex: vi.fn(async () => { throw new Error('x'); }),
      readJsonl: vi.fn(async () => { throw new Error('x'); }),
      queryAllMessages: vi.fn(async () => { throw new Error('x'); }),
      listStates: vi.fn(async () => { throw new Error('x'); }),
      listProfiles: vi.fn(async () => { throw new Error('x'); }),
    } as never);
    const m = await svc.getOverviewMetrics({ eventsFile: path.join(dir, 'none.jsonl'), wuEventsFile: path.join(dir, 'none2.jsonl') });
    expect(m.source).toBe('insufficient-data');
    expect(m.taskFlow.byStatus).toEqual({});
  });
});

describe('aggregateOverview — F6 证据台账（决策 1）', () => {
  it('分层达成 / 自评 / 人类待办 / 双轨偏差 / 派生列分布', () => {
    const input = makeInput();
    // wu-a: done + l1/l2 approved（自评）→ engaged，needsHuman（缺 l3）
    input.snapshots[0] = makeWu({
      id: 'wu-a', status: 'done', assigneeId: 'inst-1',
      createdAt: iso(T - 5 * D), claimedAt: iso(T - 4.5 * D), completedAt: iso(T - 1 * D), updatedAt: iso(T - 1 * D),
      metadataObj: {
        attestations: {
          l1: { verdict: 'approved', by: 'dev', at: iso(T - 1 * D), kind: 'verify' },
          l2: { verdict: 'approved', by: 'dev', at: iso(T - 1 * D), kind: 'agent-review', selfReview: true },
        },
      },
    });
    // wu-b: done + l2 + l3 → 派生列 done，双轨一致
    input.snapshots[1] = makeWu({
      id: 'wu-b', status: 'done', assigneeId: 'inst-2',
      createdAt: iso(T - 6 * D), claimedAt: iso(T - 6 * D), completedAt: iso(T - 2 * D), updatedAt: iso(T - 2 * D),
      metadataObj: {
        attestations: {
          l2: { verdict: 'approved', by: 'reviewer', at: iso(T - 2 * D), kind: 'agent-review' },
          l3: { verdict: 'approved', by: 'Alice', at: iso(T - 2 * D), kind: 'human-confirm' },
        },
      },
    });
    // wu-d: blocked 无证据 → legacy 透传；wu-e: unassigned legacy

    const m = aggregateOverview(input);
    expect(m.evidence.engaged).toBe(2);
    expect(m.evidence.l1Approved).toBe(1);
    expect(m.evidence.l2Approved).toBe(2);
    expect(m.evidence.l3Approved).toBe(1);
    expect(m.evidence.selfReviewCount).toBe(1);
    // needsHuman：wu-a（done 缺 l3）= 1
    expect(m.evidence.needsHuman).toBe(1);
    // 双轨偏差：wu-a 存储 done 但派生列 in_review = 1
    expect(m.evidence.derivedMismatch).toBe(1);
    expect(m.evidence.derivedByColumn).toEqual({ done: 1, in_review: 1, active: 1, blocked: 1, unassigned: 1 });
    expect(m.evidence.description).toBeTruthy();
  });

  it('无证据快照 → 全 0 但派生列分布仍有值（双轨：存储即派生）', () => {
    const m = aggregateOverview(makeInput());
    expect(m.evidence.engaged).toBe(0);
    expect(m.evidence.needsHuman).toBe(0);
    expect(m.evidence.derivedMismatch).toBe(0);
    expect(m.evidence.derivedByColumn).toEqual({ done: 2, active: 1, blocked: 1, unassigned: 1 });
  });
});
