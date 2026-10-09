/**
 * #120 验证指标三件套之 1、2：输入缓存命中率（步/WU/角色/天）+ 段 trim 率（按段）。
 * aggregateCacheHitRate / aggregateSectionTrim 纯函数 + MetricsService.getEfficiencyMetrics 文件注入。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';
import { aggregateCacheHitRate, aggregateSectionTrim, MetricsService } from '../metrics.service.js';
import { buildAssigneeProfileResolver } from '../../workunit/assignee-resolver.js';

const T = new Date('2026-07-27T12:00:00.000Z').getTime();
const H = 3600_000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();

function makeWu(id: string, assigneeId: string | null): WorkUnitSnapshot {
  return {
    id, parentId: null, type: 'feature', scope: 's', assigneeId,
    status: 'done', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, metadata: null,
    createdAt: iso(T - 5 * D), updatedAt: iso(T - 1 * D),
    claimedAt: null, completedAt: null,
  };
}

function makeCacheInput() {
  const snapshots: WorkUnitSnapshot[] = [
    makeWu('wu-a', 'inst-1'),
    makeWu('wu-b', 'inst-2'),
    makeWu('wu-c', null), // 未认领 → 角色维度不归因
  ];
  const resolveAssigneeProfile = buildAssigneeProfileResolver({
    states: [{ id: 'inst-1', roleId: 'dev' }, { id: 'inst-2', roleId: 'reviewer' }],
    profileIds: new Set(['dev', 'reviewer']),
  });
  const profileNames = new Map([['dev', '开发'], ['reviewer', '评审']]);

  const events: Array<Record<string, unknown>> = [
    // T-1d：wu-a 两次执行（两步）
    { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-a', executionId: 'e1', inputTokens: 400, cacheReadTokens: 300, cacheCreationTokens: 100 }), createdAt: iso(T - 1 * D) },
    { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-a', executionId: 'e2', inputTokens: 600, cacheReadTokens: 200 }), createdAt: iso(T - 1 * D) },
    // T-2d
    { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-b', executionId: 'e3', inputTokens: 100, cacheReadTokens: 900 }), createdAt: iso(T - 2 * D) },
    { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-c', executionId: 'e4', inputTokens: 500, cacheReadTokens: 0 }), createdAt: iso(T - 2 * D) },
    // 无缓存字段（CLI 未回报 usage）→ 不计命中率，只进覆盖率分母
    { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-a', executionId: 'e5', injectedTokens: 100, executionTokens: 900 }), createdAt: iso(T - 1 * D) },
    // 窗口外
    { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-old', inputTokens: 10, cacheReadTokens: 10 }), createdAt: iso(T - 10 * D) },
  ];

  return { snapshots, events, resolveAssigneeProfile, profileNames, now: T, windowDays: 7 };
}

describe('aggregateCacheHitRate (#120 输入缓存命中率)', () => {
  it('全局 + 步 + WU + 角色 + 天 四维度聚合（口径 cacheRead/(input+cacheRead)）', () => {
    const m = aggregateCacheHitRate(makeCacheInput());

    // 全局：ΣcacheRead=1400, Σinput=1600 → 1400/3000 = 46.67 → 47%
    expect(m.overall.cacheReadTokens).toBe(1400);
    expect(m.overall.inputTokens).toBe(1600);
    expect(m.overall.hitRatePct).toBe(47);
    expect(m.overall.events).toBe(4);
    expect(m.overall.workUnits).toBe(3); // wu-a / wu-b / wu-c
    // 覆盖率：4 个带缓存字段 / 5 个窗口内 workunit:tokens 事件 = 80%
    expect(m.coveragePct).toBe(80);

    // 步：每个带缓存字段的事件一个数据点（4 步）
    expect(m.steps).toHaveLength(4);
    expect(m.steps[0]).toMatchObject({ executionId: 'e1', workUnitId: 'wu-a', inputTokens: 400, cacheReadTokens: 300, hitRatePct: 43 });
    expect(m.steps[3]).toMatchObject({ executionId: 'e4', workUnitId: 'wu-c', inputTokens: 500, cacheReadTokens: 0, hitRatePct: 0 });

    // 天：T-2d（900/1500=60%）、T-1d（500/1500=33%），时间升序
    expect(m.byDay.map(d => d.day)).toEqual(['2026-07-25', '2026-07-26']);
    expect(m.byDay[0]).toMatchObject({ cacheReadTokens: 900, inputTokens: 600, hitRatePct: 60, events: 2 });
    expect(m.byDay[1]).toMatchObject({ cacheReadTokens: 500, inputTokens: 1000, hitRatePct: 33, events: 2 });

    // WU：wu-a 2 次、wu-b 1、wu-c 1（事件数降序）
    expect(m.byWorkUnit.map(w => w.workUnitId)).toEqual(['wu-a', 'wu-b', 'wu-c']);
    expect(m.byWorkUnit[0]).toMatchObject({ workUnitId: 'wu-a', cacheReadTokens: 500, inputTokens: 1000, hitRatePct: 33, events: 2 });
    expect(m.byWorkUnit[1]).toMatchObject({ workUnitId: 'wu-b', cacheReadTokens: 900, inputTokens: 100, hitRatePct: 90, events: 1 });

    // 角色：dev（wu-a）=33%、reviewer（wu-b）=90%；wu-c 未认领不归因
    expect(m.byRole.map(r => r.profileId)).toEqual(['dev', 'reviewer']);
    expect(m.byRole[0]).toMatchObject({ profileId: 'dev', profileName: '开发', cacheReadTokens: 500, inputTokens: 1000, hitRatePct: 33, events: 2 });
    expect(m.byRole[1]).toMatchObject({ profileId: 'reviewer', profileName: '评审', cacheReadTokens: 900, inputTokens: 100, hitRatePct: 90, events: 1 });
    expect(m.byRole.find(r => r.profileId === 'reviewer')?.events).toBe(1);

    expect(m.description).toBeTruthy();
  });

  it('空输入 → source=insufficient-data，比率 null（不编造）', () => {
    const m = aggregateCacheHitRate({
      snapshots: [], events: [],
      resolveAssigneeProfile: buildAssigneeProfileResolver({ states: [], profileIds: new Set() }),
      profileNames: new Map(), now: T, windowDays: 7,
    });
    expect(m.source).toBe('insufficient-data');
    expect(m.overall.hitRatePct).toBeNull();
    expect(m.overall.events).toBe(0);
    expect(m.steps).toHaveLength(0);
    expect(m.byDay).toHaveLength(0);
    expect(m.byWorkUnit).toHaveLength(0);
    expect(m.byRole).toHaveLength(0);
    expect(m.coveragePct).toBe(0);
  });

  it('窗口外事件不计入（windowDays=1）', () => {
    const input = makeCacheInput();
    input.windowDays = 1;
    const m = aggregateCacheHitRate(input);
    // 只剩 T-1d 的 3 个窗口内事件（e1/e2 带缓存、e5 无缓存）
    expect(m.overall.events).toBe(2);
    expect(m.overall.cacheReadTokens).toBe(500);
    expect(m.overall.inputTokens).toBe(1000);
    expect(m.overall.hitRatePct).toBe(33);
    expect(m.byDay.map(d => d.day)).toEqual(['2026-07-26']);
  });
});

describe('aggregateSectionTrim (#120 段 trim 率)', () => {
  it('按段计数 + 平均尺寸 + 平均裁减比例（事件 payload.section 动态分桶）', () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'prompt:section_trimmed', source: 'prompt-composer', payload: JSON.stringify({ section: 'knowledge', originalTokens: 1000, trimmedTokens: 600, quota: 1000 }), createdAt: iso(T - 1 * D) },
      { type: 'prompt:section_trimmed', source: 'prompt-composer', payload: JSON.stringify({ section: 'knowledge', originalTokens: 800, trimmedTokens: 700, quota: 800 }), createdAt: iso(T - 1 * D) },
      { type: 'prompt:section_trimmed', source: 'prompt-composer', payload: JSON.stringify({ section: 'map', originalTokens: 900, trimmedTokens: 450, quota: 800 }), createdAt: iso(T - 2 * D) },
      // 非 trim 事件应忽略
      { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-a' }), createdAt: iso(T - 1 * D) },
    ];

    const m = aggregateSectionTrim({ events, now: T, windowDays: 7 });

    expect(m.totals.trimEvents).toBe(3);
    expect(m.totals.totalOriginalTokens).toBe(2700);
    expect(m.totals.totalTrimmedTokens).toBe(1750);

    // knowledge: trim 2 次，avgOriginal 900，avgTrimmed 650，avgTrimPct (40+12.5)/2=26.25→26
    expect(m.bySection.map(s => s.section)).toEqual(['knowledge', 'map']);
    expect(m.bySection[0]).toMatchObject({
      section: 'knowledge', trimCount: 2, avgOriginalTokens: 900, avgTrimmedTokens: 650, avgTrimPct: 26,
    });
    expect(m.bySection[1]).toMatchObject({
      section: 'map', trimCount: 1, avgOriginalTokens: 900, avgTrimmedTokens: 450, avgTrimPct: 50,
    });

    expect(m.description).toBeTruthy();
  });

  it('空输入 → source=insufficient-data', () => {
    const m = aggregateSectionTrim({ events: [], now: T, windowDays: 7 });
    expect(m.source).toBe('insufficient-data');
    expect(m.totals.trimEvents).toBe(0);
    expect(m.bySection).toHaveLength(0);
  });
});

// ─── MetricsService.getEfficiencyMetrics：文件注入 ───

describe('MetricsService.getEfficiencyMetrics', () => {
  it('从文件聚合出与纯函数一致的结果', async () => {
    const input = makeCacheInput();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efficiency-'));
    try {
      const eventsFile = path.join(dir, 'studio-events.jsonl');
      const trimEvents = [
        { type: 'prompt:section_trimmed', source: 'prompt-composer', payload: JSON.stringify({ section: 'knowledge', originalTokens: 1000, trimmedTokens: 600, quota: 1000 }), createdAt: iso(T - 1 * D) },
      ];
      // #335：窗口读口依赖文件时间单调（生产 = append-only 单调）——
      // 按 createdAt 排序落盘，与生产文件形态一致（原拼接顺序把 T-10d 窗口外行夹在中间）
      const allEvents = [...input.events, ...trimEvents]
        .sort((a, b) => Date.parse(a.createdAt as string) - Date.parse(b.createdAt as string));
      fs.writeFileSync(eventsFile, allEvents.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

      const fileStoreStub = {
        getIndex: vi.fn(async () => input.snapshots),
        listStates: vi.fn(async () => [{ id: 'inst-1', roleId: 'dev' }, { id: 'inst-2', roleId: 'reviewer' }]),
        listProfiles: vi.fn(async () => [{ id: 'dev', name: '开发' }, { id: 'reviewer', name: '评审' }]),
      };

      const svc = new MetricsService(fileStoreStub as never);
      const m = await svc.getEfficiencyMetrics({ eventsFile, now: T });
      expect(m.cacheHitRate.source).toBe('events');
      expect(m.cacheHitRate.overall.hitRatePct).toBe(47);
      expect(m.cacheHitRate.byRole.find(r => r.profileId === 'reviewer')?.hitRatePct).toBe(90);
      expect(m.sectionTrim.source).toBe('events');
      expect(m.sectionTrim.bySection[0]).toMatchObject({ section: 'knowledge', trimCount: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('事件文件不存在 → source=insufficient-data，不抛出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efficiency-empty-'));
    try {
      const svc = new MetricsService({
        getIndex: vi.fn(async () => [] as WorkUnitSnapshot[]),
        listStates: vi.fn(async () => []),
        listProfiles: vi.fn(async () => []),
      } as never);
      const m = await svc.getEfficiencyMetrics({ eventsFile: path.join(dir, 'none.jsonl'), now: T });
      expect(m.cacheHitRate.source).toBe('insufficient-data');
      expect(m.sectionTrim.source).toBe('insufficient-data');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
