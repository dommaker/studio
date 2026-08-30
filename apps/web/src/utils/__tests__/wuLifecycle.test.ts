// #396：WU 生命周期纯函数——四站 stepper 状态/时间戳 + 关键事件派生
import { describe, it, expect } from 'vitest';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../../api/workunit';
import { stationIndex, buildLifecycle } from '../wuLifecycle';

const baseWu: WorkUnit = {
  id: 'wu-1',
  parentId: null,
  dependsOn: '',
  type: 'task',
  scope: '实现登录功能',
  assigneeId: 'inst-1',
  status: 'active',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  reqId: 'REQ-0042',
  metadata: '{}',
  createdAt: '2026-07-30T09:00:00Z',
  updatedAt: '2026-07-30T10:00:00Z',
  claimedAt: '2026-07-30T09:30:00Z',
  completedAt: null,
};

const ATTEST = {
  l1: { verdict: 'approved', by: 'profile-aaa', at: '2026-07-30T10:00:00Z', kind: 'verify' },
  l2: { verdict: 'approved', by: 'profile-bbb', at: '2026-07-30T11:00:00Z', kind: 'agent-review', summary: 'LGTM' },
  l3: { verdict: 'approved', by: 'human-ccc', at: '2026-07-30T12:00:00Z', kind: 'human-confirm' },
} as const;

function build(wu: WorkUnit, meta: Record<string, unknown> = {}) {
  const derived = deriveDisplayState({ status: wu.status, metadata: wu.metadata });
  const attestations = Object.keys(meta).length > 0 && meta.attestations
    ? (meta.attestations as Parameters<typeof buildLifecycle>[3])
    : undefined;
  return buildLifecycle(wu, derived, meta, attestations);
}

describe('stationIndex（四站映射）', () => {
  it('pending/unassigned → 0 待领取；active/blocked → 1 进行中；in_review → 2 待验收；done/closed → 3 完成', () => {
    expect(stationIndex('pending')).toBe(0);
    expect(stationIndex('unassigned')).toBe(0);
    expect(stationIndex('active')).toBe(1);
    expect(stationIndex('blocked')).toBe(1);
    expect(stationIndex('in_review')).toBe(2);
    expect(stationIndex('done')).toBe(3);
    expect(stationIndex('closed')).toBe(3);
  });
});

describe('buildLifecycle.stations', () => {
  it('进行中 WU：待领取 done（时间=创建）、进行中 current（时间=认领）、后两站 upcoming', () => {
    const { stations } = build(baseWu);
    expect(stations.map(s => s.id)).toEqual(['claim', 'progress', 'review', 'done']);
    expect(stations.map(s => s.label)).toEqual(['待领取', '进行中', '待验收', '完成']);
    expect(stations.map(s => s.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(stations[0].time).toBe('2026-07-30T09:00:00Z');
    expect(stations[1].time).toBe('2026-07-30T09:30:00Z');
    expect(stations[2].time).toBeNull();
    expect(stations[3].time).toBeNull();
  });

  it('done WU（证据齐全）：四站全 done，完成时间 = completedAt', () => {
    const wu: WorkUnit = {
      ...baseWu,
      status: 'done',
      completedAt: '2026-07-30T12:30:00Z',
      metadata: JSON.stringify({ attestations: ATTEST }),
    };
    const { stations } = build(wu, { attestations: ATTEST });
    expect(stations.map(s => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(stations[3].time).toBe('2026-07-30T12:30:00Z');
  });

  it('closed WU：末站标签为「关闭」', () => {
    const wu: WorkUnit = { ...baseWu, status: 'closed', completedAt: '2026-07-30T12:30:00Z' };
    const { stations } = build(wu);
    expect(stations[3].label).toBe('关闭');
    expect(stations[3].state).toBe('done');
  });

  it('待验收站时间戳口径（§5.6.2）：l2.at 优先，缺 l2 落 l1.at，皆无则 null', () => {
    const wu: WorkUnit = { ...baseWu, status: 'in_review' };
    // l2 + l1 都在 → l2.at
    expect(build(wu, { attestations: { l1: ATTEST.l1, l2: ATTEST.l2 } }).stations[2].time)
      .toBe('2026-07-30T11:00:00Z');
    // 只有 l1 → l1.at
    expect(build(wu, { attestations: { l1: ATTEST.l1 } }).stations[2].time)
      .toBe('2026-07-30T10:00:00Z');
    // 无证据 → null
    expect(build(wu).stations[2].time).toBeNull();
  });
});

describe('buildLifecycle.events（关键事件 chip）', () => {
  it('pending 人闸事件（warn）', () => {
    const wu: WorkUnit = { ...baseWu, status: 'pending' };
    const { events } = build(wu);
    const ev = events.find(e => e.id === 'gate-pending');
    expect(ev).toBeDefined();
    expect(ev!.tone).toBe('warn');
    expect(ev!.time).toBe('2026-07-30T09:00:00Z');
  });

  it('blocked → 阻塞事件（danger，detail=failureType，time=updatedAt）', () => {
    const wu: WorkUnit = { ...baseWu, status: 'blocked', failureType: 'stuck' };
    const { events } = build(wu);
    const ev = events.find(e => e.id === 'blocked');
    expect(ev).toMatchObject({ label: '阻塞', detail: 'stuck', tone: 'danger', time: '2026-07-30T10:00:00Z' });
  });

  it('非 blocked 但有 failureType → 失败事件（danger）', () => {
    const wu: WorkUnit = { ...baseWu, status: 'done', completedAt: '2026-07-30T12:00:00Z', failureType: 'timeout' };
    const { events } = build(wu);
    expect(events.find(e => e.id === 'failure')).toMatchObject({ label: '失败', detail: 'timeout', tone: 'danger' });
    expect(events.find(e => e.id === 'blocked')).toBeUndefined();
  });

  it('挂起等待输入事件（warn，detail=waitingQuestion，time=waitingSince 优先）', () => {
    const meta = { waitingForInput: true, waitingQuestion: '用 OAuth 吗？', waitingSince: '2026-07-30T09:45:00Z' };
    const { events } = build(baseWu, meta);
    expect(events.find(e => e.id === 'waiting')).toMatchObject({
      label: '挂起等待输入', detail: '用 OAuth 吗？', tone: 'warn', time: '2026-07-30T09:45:00Z',
    });
    // 无 waitingSince → updatedAt 兜底
    const { events: ev2 } = build(baseWu, { waitingForInput: true });
    expect(ev2.find(e => e.id === 'waiting')!.time).toBe('2026-07-30T10:00:00Z');
  });

  it('L1/L2/L3 证据事件：approved=accent「通过」/ rejected=danger「否决」；自评标注', () => {
    const wu: WorkUnit = { ...baseWu, status: 'done', completedAt: '2026-07-30T12:30:00Z' };
    const meta = {
      attestations: {
        l1: ATTEST.l1,
        l2: { ...ATTEST.l2, selfReview: true },
        l3: { verdict: 'rejected', by: 'human-ccc', at: '2026-07-30T12:00:00Z', kind: 'human-confirm' },
      },
    };
    const { events } = build(wu, meta);
    expect(events.find(e => e.id === 'l1')).toMatchObject({ label: 'L1 自动验证通过', tone: 'accent', time: ATTEST.l1.at });
    expect(events.find(e => e.id === 'l2')).toMatchObject({ label: 'L2 Agent 评审通过（自评）', tone: 'accent' });
    expect(events.find(e => e.id === 'l3')).toMatchObject({ label: 'L3 人工验收否决', tone: 'danger' });
  });

  it('无事态 WU → events 为空（chip 行不占位）', () => {
    expect(build(baseWu).events).toEqual([]);
  });
});
