// AC-5: 进度管道纯函数测试 — 泳道分组 / 完成度口径 / 耗时 / 项目动态拼装
import { describe, it, expect } from 'vitest';
import {
  laneOfWorkUnit,
  groupWorkUnitsByLane,
  computePipelineProgress,
  formatDuration,
  buildProjectTimeline,
  formatTimelineTime,
  type PipelineWorkUnit,
} from '../pipelineUtils';

const l3ApprovedMeta = JSON.stringify({
  attestations: { l3: { verdict: 'approved', by: 'human', at: '2026-07-01T00:00:00Z', kind: 'human-confirm' } },
});
const l1OnlyMeta = JSON.stringify({
  attestations: { l1: { verdict: 'approved', by: 'dev', at: '2026-07-01T00:00:00Z', kind: 'verify' } },
});

const wu = (over: Partial<PipelineWorkUnit>): PipelineWorkUnit => ({
  id: over.id ?? 'wu-x',
  title: over.title ?? '任务',
  status: over.status ?? 'unassigned',
  assigneeId: over.assigneeId ?? null,
  ...over,
});

describe('laneOfWorkUnit', () => {
  it('所有权状态原样落列', () => {
    expect(laneOfWorkUnit(wu({ status: 'unassigned' }))).toBe('unassigned');
    expect(laneOfWorkUnit(wu({ status: 'active' }))).toBe('active');
    expect(laneOfWorkUnit(wu({ status: 'in_review' }))).toBe('in_review');
    expect(laneOfWorkUnit(wu({ status: 'blocked' }))).toBe('blocked');
  });

  it('done/closed → 已完成列；failed/completed（词表外终结态）防御归并', () => {
    expect(laneOfWorkUnit(wu({ status: 'done' }))).toBe('done');
    expect(laneOfWorkUnit(wu({ status: 'closed' }))).toBe('done');
    expect(laneOfWorkUnit(wu({ status: 'failed' }))).toBe('done');
    expect(laneOfWorkUnit(wu({ status: 'completed' }))).toBe('done');
  });

  it('F6 派生：done 且证据已介入但缺 L3 → 回评审中列；L3 approved → 已完成', () => {
    expect(laneOfWorkUnit(wu({ status: 'done', metadata: l1OnlyMeta }))).toBe('in_review');
    expect(laneOfWorkUnit(wu({ status: 'done', metadata: l3ApprovedMeta }))).toBe('done');
  });
});

describe('groupWorkUnitsByLane', () => {
  it('五泳道分组，空列保持空数组，顺序保持输入序', () => {
    const lanes = groupWorkUnitsByLane([
      wu({ id: 'a', status: 'active' }),
      wu({ id: 'b', status: 'unassigned' }),
      wu({ id: 'c', status: 'done' }),
      wu({ id: 'd', status: 'active' }),
      wu({ id: 'e', status: 'blocked' }),
      wu({ id: 'f', status: 'done', metadata: l1OnlyMeta }),
    ]);
    expect(lanes.unassigned.map(x => x.id)).toEqual(['b']);
    expect(lanes.active.map(x => x.id)).toEqual(['a', 'd']);
    expect(lanes.in_review.map(x => x.id)).toEqual(['f']);
    expect(lanes.blocked.map(x => x.id)).toEqual(['e']);
    expect(lanes.done.map(x => x.id)).toEqual(['c']);
  });
});

describe('computePipelineProgress', () => {
  it('完成口径 = workFinished（done 缺 L3 仍算完成；in_review 不算）', () => {
    const p = computePipelineProgress([
      wu({ status: 'done' }),
      wu({ status: 'closed' }),
      wu({ status: 'done', metadata: l1OnlyMeta }),
      wu({ status: 'failed' }),
      wu({ status: 'in_review' }),
      wu({ status: 'active' }),
    ]);
    expect(p).toEqual({ finished: 4, total: 6, percent: 67 });
  });

  it('空列表 → 0/0/0', () => {
    expect(computePipelineProgress([])).toEqual({ finished: 0, total: 0, percent: 0 });
  });
});

describe('formatDuration', () => {
  it('无 claimedAt / 坏时间 → null', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration('not-a-date')).toBeNull();
  });

  it('分/小时/天档位', () => {
    const start = '2026-07-01T00:00:00Z';
    expect(formatDuration(start, '2026-07-01T00:00:30Z')).toBe('<1m');
    expect(formatDuration(start, '2026-07-01T00:45:00Z')).toBe('45m');
    expect(formatDuration(start, '2026-07-01T03:20:00Z')).toBe('3h20m');
    expect(formatDuration(start, '2026-07-01T02:00:00Z')).toBe('2h');
    expect(formatDuration(start, '2026-07-03T03:00:00Z')).toBe('2d3h');
  });

  it('无 completedAt → 算到 now', () => {
    const now = Date.parse('2026-07-01T01:00:00Z');
    expect(formatDuration('2026-07-01T00:00:00Z', null, now)).toBe('1h');
  });
});

describe('buildProjectTimeline', () => {
  const wus: PipelineWorkUnit[] = [
    wu({
      id: 'wu-1', title: '设计', status: 'done', assigneeId: 'inst-1',
      createdAt: '2026-07-01T08:00:00Z', claimedAt: '2026-07-02T09:00:00Z', completedAt: '2026-07-03T10:00:00Z',
    }),
    wu({
      id: 'wu-2', title: '实现', status: 'active', assigneeId: 'inst-x',
      createdAt: '2026-07-04T08:00:00Z', claimedAt: '2026-07-05T09:00:00Z',
    }),
    wu({ id: 'wu-bad', title: '坏数据', status: 'unassigned', createdAt: 'not-a-date' }),
  ];

  it('倒序拼装 created/claimed/completed + delivered；认领人名经名册解析', () => {
    const entries = buildProjectTimeline(wus, {
      deliveredAt: '2026-07-06T00:00:00Z',
      agentNameById: { 'inst-1': 'dev' },
    });
    expect(entries.map(e => e.id)).toEqual([
      'delivered',
      'claimed:wu-2',
      'created:wu-2',
      'completed:wu-1',
      'claimed:wu-1',
      'created:wu-1',
    ]);
    expect(entries.find(e => e.id === 'claimed:wu-1')?.actorName).toBe('dev');
    // 名册未命中 → null（渲染回退 'agent'）
    expect(entries.find(e => e.id === 'claimed:wu-2')?.actorName).toBeNull();
    expect(entries.find(e => e.id === 'completed:wu-1')?.status).toBe('done');
  });

  it('坏时间戳条目被过滤；超过 20 条截断', () => {
    const many: PipelineWorkUnit[] = Array.from({ length: 8 }, (_, i) =>
      wu({
        id: `wu-${i}`,
        createdAt: `2026-07-0${i + 1}T08:00:00Z`,
        claimedAt: `2026-07-0${i + 1}T09:00:00Z`,
        completedAt: `2026-07-0${i + 1}T10:00:00Z`,
        status: 'done',
      }));
    const entries = buildProjectTimeline([...many, ...wus]);
    expect(entries.some(e => e.wuId === 'wu-bad')).toBe(false);
    expect(entries.length).toBe(20);
  });
});

describe('formatTimelineTime', () => {
  it('MM-dd HH:mm；坏时间 → 空串', () => {
    // 不带 Z 的 ISO 按本地时区解析，不受测试机 TZ 影响
    expect(formatTimelineTime('2026-07-05T14:03:00')).toBe('07-05 14:03');
    expect(formatTimelineTime('bogus')).toBe('');
  });
});
