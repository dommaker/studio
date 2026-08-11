/**
 * evidence-summary 共享证据口径单测：
 * 归属选择（reqId → pmoId 回退）+ 三层证据齐缺派生（l1 限代码类 / l2 豁免 review/analysis / l3 全员）。
 */
import { describe, it, expect } from 'vitest';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';
import { parseWuMetaPmoId, selectProjectSnapshots, summarizeEvidence } from '../evidence-summary.js';

let seq = 0;
function wu(overrides: Partial<WorkUnitSnapshot> & { metadataObj?: Record<string, unknown> }): WorkUnitSnapshot {
  const { metadataObj, ...rest } = overrides;
  return {
    id: `wu-${++seq}`, parentId: null, type: 'task', scope: 's', assigneeId: null,
    status: 'done', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, reqId: 'REQ-1',
    metadata: metadataObj ? JSON.stringify(metadataObj) : null,
    createdAt: '2026-07-29T00:00:00Z', updatedAt: '2026-07-29T00:00:00Z',
    claimedAt: null, completedAt: '2026-07-29T01:00:00Z',
    ...rest,
  };
}

const att = (kind: string, extra: Record<string, unknown> = {}) => ({
  verdict: 'approved', by: 'x', at: '2026-07-29T00:30:00Z', kind, ...extra,
});
const fullEvidence = { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } };

describe('parseWuMetaPmoId', () => {
  it('正常解析 / 无字段 / 坏 JSON / null / 空字符串', () => {
    expect(parseWuMetaPmoId(JSON.stringify({ pmoId: 'proj-1' }))).toBe('proj-1');
    expect(parseWuMetaPmoId(JSON.stringify({ title: 'x' }))).toBeNull();
    expect(parseWuMetaPmoId('{broken')).toBeNull();
    expect(parseWuMetaPmoId(null)).toBeNull();
    expect(parseWuMetaPmoId(JSON.stringify({ pmoId: '' }))).toBeNull();
  });
});

describe('selectProjectSnapshots', () => {
  it('优先按 Requirement.projectId 关联 reqId 集合', () => {
    const mine = wu({ reqId: 'REQ-1' });
    const other = wu({ reqId: 'REQ-2' });
    const s = selectProjectSnapshots('proj-1', [{ id: 'REQ-1', projectId: 'proj-1' }], [mine, other]);
    expect(s.map(x => x.id)).toEqual([mine.id]);
  });

  it('reqId 归属为空时回退 metadata.pmoId（analysis 派生链）', () => {
    const mine = wu({ reqId: null, metadataObj: { pmoId: 'proj-1' } });
    const other = wu({ reqId: null, metadataObj: { pmoId: 'proj-2' } });
    const s = selectProjectSnapshots('proj-1', [], [mine, other]);
    expect(s.map(x => x.id)).toEqual([mine.id]);
  });

  it('reqId 有命中时不走 pmoId 回退（避免双口径混计）', () => {
    const byReq = wu({ reqId: 'REQ-1' });
    const byPmo = wu({ reqId: null, metadataObj: { pmoId: 'proj-1' } });
    const s = selectProjectSnapshots('proj-1', [{ id: 'REQ-1', projectId: 'proj-1' }], [byReq, byPmo]);
    expect(s.map(x => x.id)).toEqual([byReq.id]);
  });

  it('两种口径都无命中 → 空', () => {
    const other = wu({ reqId: 'REQ-9' });
    expect(selectProjectSnapshots('proj-1', [], [other])).toEqual([]);
  });
});

describe('summarizeEvidence', () => {
  it('空快照 → 不可交付', () => {
    const s = summarizeEvidence([]);
    expect(s.total).toBe(0);
    expect(s.deliverable).toBe(false);
  });

  it('三层证据齐 → deliverable；byStatus 只统计在途', () => {
    const s = summarizeEvidence([wu({ metadataObj: fullEvidence })]);
    expect(s).toMatchObject({
      total: 1, finished: 1, inFlight: 0,
      byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 },
      l1Missing: [], l2Missing: [], l3Missing: [], selfReviewCount: 0,
      deliverable: true,
    });
  });

  it('代码类 WU 缺证据 → 三层缺口各自分桶', () => {
    const bare = wu({ metadataObj: {} });
    const s = summarizeEvidence([bare]);
    expect(s.l1Missing).toEqual([bare.id]); // task 属代码类，要求 l1
    expect(s.l2Missing).toEqual([bare.id]);
    expect(s.l3Missing).toEqual([bare.id]);
    expect(s.deliverable).toBe(false);
  });

  it('非代码类 WU 不要求 l1，但 l2/l3 仍要求', () => {
    const doc = wu({ type: 'discussion', metadataObj: { attestations: { l2: att('agent-review'), l3: att('human-confirm') } } });
    const s = summarizeEvidence([doc]);
    expect(s.l1Missing).toEqual([]);
    expect(s.deliverable).toBe(true);
  });

  it('review/analysis 豁免 l2，但 l3 不豁免', () => {
    const analysis = wu({ type: 'analysis', metadataObj: { attestations: { l3: att('human-confirm') } } });
    expect(summarizeEvidence([analysis]).deliverable).toBe(true);

    const noL3 = wu({ type: 'analysis', metadataObj: {} });
    const s2 = summarizeEvidence([noL3]);
    expect(s2.l2Missing).toEqual([]);
    expect(s2.l3Missing).toEqual([noL3.id]);
    expect(s2.deliverable).toBe(false);
  });

  it('#108: decision/spec 豁免 l2（人工验收类工单不派评审），l3 仍要求', () => {
    for (const type of ['decision', 'spec']) {
      const withL3 = wu({ type, metadataObj: { attestations: { l3: att('human-confirm') } } });
      expect(summarizeEvidence([withL3]).deliverable).toBe(true);

      const noL3 = wu({ type, metadataObj: {} });
      const s = summarizeEvidence([noL3]);
      expect(s.l2Missing).toEqual([]);
      expect(s.l3Missing).toEqual([noL3.id]);
      expect(s.deliverable).toBe(false);
    }
  });

  it('closed 计入 finished；在途 WU 按原始状态进 byStatus 且阻断交付', () => {
    const done = wu({ metadataObj: fullEvidence });
    const closed = wu({ status: 'closed', metadataObj: fullEvidence });
    const active = wu({ status: 'active', metadataObj: {} });
    const inReview = wu({ status: 'in_review', metadataObj: {} });
    const unassigned = wu({ status: 'unassigned', metadataObj: {} });
    const blocked = wu({ status: 'blocked', metadataObj: {} });
    const s = summarizeEvidence([done, closed, active, inReview, unassigned, blocked]);
    expect(s.finished).toBe(2);
    expect(s.inFlight).toBe(4);
    expect(s.byStatus).toEqual({ unassigned: 1, active: 1, inReview: 1, blocked: 1 });
    expect(s.deliverable).toBe(false); // 有在途即不可交付
  });

  it('l2 自评计数（不阻断交付）', () => {
    const self = wu({ metadataObj: { attestations: { l1: att('verify'), l2: att('agent-review', { selfReview: true }), l3: att('human-confirm') } } });
    const s = summarizeEvidence([self]);
    expect(s.selfReviewCount).toBe(1);
    expect(s.deliverable).toBe(true);
  });
});
