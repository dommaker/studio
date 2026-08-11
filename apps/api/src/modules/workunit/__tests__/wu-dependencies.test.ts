// #109（T3，#106 子票）blockedBy 依赖解析与可认领判定单元测试。
// 纯函数叶子 wu-dependencies.ts：parseBlockedBy / hasUnfinishedDeps / resolveClaimable。
import { describe, it, expect } from 'vitest';
import { parseBlockedBy, buildStatusById, hasUnfinishedDeps, resolveClaimable } from '../wu-dependencies.js';

describe('parseBlockedBy', () => {
  it('解析字符串 metadata 的 blockedBy 数组', () => {
    expect(parseBlockedBy(JSON.stringify({ blockedBy: ['wu-1', 'wu-2'] }))).toEqual(['wu-1', 'wu-2']);
  });

  it('对象 metadata 直读', () => {
    expect(parseBlockedBy({ blockedBy: ['wu-1'] })).toEqual(['wu-1']);
  });

  it('缺失 / null / 坏 JSON / 非对象 → []', () => {
    expect(parseBlockedBy(undefined)).toEqual([]);
    expect(parseBlockedBy(null)).toEqual([]);
    expect(parseBlockedBy('{')).toEqual([]);
    expect(parseBlockedBy('"str"')).toEqual([]);
    expect(parseBlockedBy(JSON.stringify({}))).toEqual([]);
  });

  it('blockedBy 非数组 → []；数组内非字符串/空串项剔除', () => {
    expect(parseBlockedBy({ blockedBy: 'wu-1' })).toEqual([]);
    expect(parseBlockedBy({ blockedBy: ['wu-1', 42, '', null, 'wu-2'] })).toEqual(['wu-1', 'wu-2']);
  });
});

describe('buildStatusById', () => {
  it('从快照构建 id → status 映射', () => {
    const map = buildStatusById([
      { id: 'wu-1', status: 'done' },
      { id: 'wu-2', status: 'active' },
    ]);
    expect(map.get('wu-1')).toBe('done');
    expect(map.get('wu-2')).toBe('active');
    expect(map.size).toBe(2);
  });
});

describe('hasUnfinishedDeps', () => {
  const statusById = new Map([
    ['wu-done', 'done'],
    ['wu-active', 'active'],
    ['wu-closed', 'closed'],
  ]);

  it('全部依赖 done → false', () => {
    expect(hasUnfinishedDeps({ blockedBy: ['wu-done'] }, statusById)).toBe(false);
  });

  it('任一依赖未了结 → true', () => {
    expect(hasUnfinishedDeps({ blockedBy: ['wu-done', 'wu-active'] }, statusById)).toBe(true);
  });

  it('依赖 closed 视为已了结（终态不可能再 done）→ false', () => {
    expect(hasUnfinishedDeps({ blockedBy: ['wu-closed'] }, statusById)).toBe(false);
  });

  it('引用缺失 id（已删除/笔误）保守按未了结 → true', () => {
    expect(hasUnfinishedDeps({ blockedBy: ['wu-missing'] }, statusById)).toBe(true);
  });

  it('无 blockedBy / 空数组 → false', () => {
    expect(hasUnfinishedDeps({}, statusById)).toBe(false);
    expect(hasUnfinishedDeps({ blockedBy: [] }, statusById)).toBe(false);
  });
});

describe('resolveClaimable', () => {
  const statusById = new Map([
    ['wu-done', 'done'],
    ['wu-active', 'active'],
  ]);

  it('unassigned 且无未完结依赖 → true', () => {
    expect(resolveClaimable({ status: 'unassigned', metadata: null }, statusById)).toBe(true);
    expect(resolveClaimable({ status: 'unassigned', metadata: JSON.stringify({ blockedBy: ['wu-done'] }) }, statusById)).toBe(true);
  });

  it('unassigned 但有未完结依赖 → false', () => {
    expect(resolveClaimable({ status: 'unassigned', metadata: JSON.stringify({ blockedBy: ['wu-active'] }) }, statusById)).toBe(false);
  });

  it('非 unassigned → false（与依赖无关）', () => {
    expect(resolveClaimable({ status: 'active', metadata: null }, statusById)).toBe(false);
    expect(resolveClaimable({ status: 'done', metadata: JSON.stringify({ blockedBy: ['wu-done'] }) }, statusById)).toBe(false);
  });
});
