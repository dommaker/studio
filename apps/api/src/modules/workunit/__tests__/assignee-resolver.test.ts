/**
 * assignee-resolver 单测：assigneeId 双语义批量解析。
 *
 * 口径（语义权威 workunit/CONTEXT.md）：
 *   - 认领后 assigneeId = 实例 id → state.roleId（profile id）
 *   - 未认领指名 assigneeId = profile id → 直通（须在 profileIds 内）
 *   - 未知 id / null / undefined / 空串 → null，不编造
 */
import { describe, it, expect } from 'vitest';
import { buildAssigneeProfileResolver } from '../assignee-resolver.js';

function makeResolver() {
  return buildAssigneeProfileResolver({
    states: [
      { id: 'inst-1', roleId: 'dev' },
      { id: 'inst-2', roleId: 'reviewer' },
      { id: 'inst-3', roleId: 'dev' }, // 多实例同 profile
    ],
    profileIds: new Set(['dev', 'reviewer', 'pm']),
  });
}

describe('buildAssigneeProfileResolver', () => {
  it('实例形态：instance id → state.roleId', () => {
    const resolve = makeResolver();
    expect(resolve('inst-1')).toBe('dev');
    expect(resolve('inst-2')).toBe('reviewer');
    expect(resolve('inst-3')).toBe('dev');
  });

  it('profile-id 形态（未认领指名）：命中 profileIds 直通', () => {
    const resolve = makeResolver();
    expect(resolve('pm')).toBe('pm');
    expect(resolve('dev')).toBe('dev');
  });

  it('未知 id（既非实例也非 profile）→ null', () => {
    const resolve = makeResolver();
    expect(resolve('ghost')).toBeNull();
  });

  it('null / undefined / 空串 → null（不抛错）', () => {
    const resolve = makeResolver();
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve('')).toBeNull();
  });

  it('实例 map 命中优先于 profileIds（id 撞名时按认领形态解析）', () => {
    const resolve = buildAssigneeProfileResolver({
      states: [{ id: 'dev', roleId: 'real-profile' }],
      profileIds: new Set(['dev']),
    });
    expect(resolve('dev')).toBe('real-profile');
  });

  it('state 缺 id/roleId 的脏行跳过，不进 map', () => {
    const resolve = buildAssigneeProfileResolver({
      states: [{ id: 'inst-1', roleId: null }, { id: null, roleId: 'dev' }, { id: 'inst-2', roleId: 'dev' }],
      profileIds: new Set(),
    });
    expect(resolve('inst-1')).toBeNull();
    expect(resolve('inst-2')).toBe('dev');
  });

  it('空输入 → 一切解析为 null', () => {
    const resolve = buildAssigneeProfileResolver({ states: [], profileIds: new Set() });
    expect(resolve('inst-1')).toBeNull();
    expect(resolve('dev')).toBeNull();
  });
});
