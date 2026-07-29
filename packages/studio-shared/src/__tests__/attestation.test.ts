import { describe, it, expect } from 'vitest';
import { deriveDisplayState, parseAttestations, withAttestation, type WuAttestations } from '../attestation';

const l1Approved = { verdict: 'approved' as const, by: 'profile-dev', at: '2026-07-29T00:00:00Z', kind: 'verify' };
const l2Approved = { verdict: 'approved' as const, by: 'profile-reviewer', at: '2026-07-29T00:01:00Z', kind: 'agent-review', ref: 'wu-child-1' };
const l3Approved = { verdict: 'approved' as const, by: 'alice', at: '2026-07-29T00:02:00Z', kind: 'human-confirm' };

describe('parseAttestations', () => {
  it('parses metadata object and JSON string', () => {
    const att = { l1: l1Approved };
    expect(parseAttestations({ attestations: att })?.l1?.by).toBe('profile-dev');
    expect(parseAttestations(JSON.stringify({ attestations: att }))?.l1?.kind).toBe('verify');
  });

  it('returns undefined for missing/corrupt/empty data', () => {
    expect(parseAttestations(undefined)).toBeUndefined();
    expect(parseAttestations(null)).toBeUndefined();
    expect(parseAttestations('not json')).toBeUndefined();
    expect(parseAttestations({})).toBeUndefined();
    expect(parseAttestations({ attestations: {} })).toBeUndefined();
    expect(parseAttestations({ attestations: { l1: { verdict: 'weird' } } })).toBeUndefined();
  });

  it('keeps selfReview flag only when true', () => {
    const att = parseAttestations({
      attestations: { l2: { ...l2Approved, selfReview: true } },
    });
    expect(att?.l2?.selfReview).toBe(true);
  });
});

describe('withAttestation', () => {
  it('adds a level without mutating existing and overwrites latest per level', () => {
    const base: WuAttestations = { l1: l1Approved };
    const next = withAttestation(base, 'l2', l2Approved);
    expect(base.l2).toBeUndefined();
    expect(next.l1?.by).toBe('profile-dev');
    expect(next.l2?.by).toBe('profile-reviewer');
    const replaced = withAttestation(next, 'l1', { ...l1Approved, at: '2026-07-29T01:00:00Z' });
    expect(replaced.l1?.at).toBe('2026-07-29T01:00:00Z');
    expect(replaced.l2?.by).toBe('profile-reviewer');
  });
});

describe('deriveDisplayState（双轨期规则）', () => {
  it('ownership 状态原样透传', () => {
    for (const status of ['unassigned', 'active', 'blocked', 'closed']) {
      expect(deriveDisplayState({ status }).column).toBe(status);
    }
  });

  it('手写 in_review 保持权威（门模型仍在跑）', () => {
    const d = deriveDisplayState({ status: 'in_review' });
    expect(d.column).toBe('in_review');
    expect(d.needsHuman).toBe(true);
    expect(d.hasAttestations).toBe(false);
  });

  it('done 无证据 = legacy 存量，原样 done 且不算人类待办', () => {
    const d = deriveDisplayState({ status: 'done' });
    expect(d.column).toBe('done');
    expect(d.needsHuman).toBe(false);
    expect(d.hasAttestations).toBe(false);
  });

  it('workFinished 是所有权口径：done/closed 为 true，与信任列无关', () => {
    expect(deriveDisplayState({ status: 'done' }).workFinished).toBe(true);
    expect(deriveDisplayState({ status: 'closed' }).workFinished).toBe(true);
    expect(deriveDisplayState({ status: 'in_review' }).workFinished).toBe(false);
    // done + 缺 l3 → 信任列回 in_review，但活已干完（进度统计不受影响）
    const d = deriveDisplayState({
      status: 'done',
      metadata: { attestations: { l1: l1Approved } },
    });
    expect(d.column).toBe('in_review');
    expect(d.workFinished).toBe(true);
  });

  it('done + l1/l2 缺 l3 → 回 in_review 列（等人工确认）', () => {
    const d = deriveDisplayState({
      status: 'done',
      metadata: { attestations: { l1: l1Approved, l2: l2Approved } },
    });
    expect(d.column).toBe('in_review');
    expect(d.needsHuman).toBe(true);
    expect(d.evidence).toEqual({ l1: true, l2: true, l3: false, selfReview: false });
  });

  it('done + l3 approved → done 列（l3 是最终闸门，无 l2 不阻断人工验收）', () => {
    const withAll = deriveDisplayState({
      status: 'done',
      metadata: { attestations: { l1: l1Approved, l2: l2Approved, l3: l3Approved } },
    });
    expect(withAll.column).toBe('done');
    expect(withAll.needsHuman).toBe(false);

    const humanOnly = deriveDisplayState({
      status: 'done',
      metadata: { attestations: { l3: l3Approved } },
    });
    expect(humanOnly.column).toBe('done');
    expect(humanOnly.needsHuman).toBe(false);
    expect(humanOnly.evidence.l2).toBe(false);
  });

  it('l2 rejected 不算达成；selfReview 标记透出', () => {
    const d = deriveDisplayState({
      status: 'done',
      metadata: {
        attestations: { l2: { ...l2Approved, verdict: 'rejected' as const, selfReview: true } },
      },
    });
    expect(d.evidence.l2).toBe(false);
    expect(d.evidence.selfReview).toBe(true);
    expect(d.column).toBe('in_review');
  });

  it('metadata 为 JSON 字符串时同样可派生', () => {
    const d = deriveDisplayState({
      status: 'done',
      metadata: JSON.stringify({ attestations: { l3: l3Approved } }),
    });
    expect(d.column).toBe('done');
  });

  it('未知状态兜底 active，不放大异常数据', () => {
    expect(deriveDisplayState({ status: 'whatever' }).column).toBe('active');
  });
});
